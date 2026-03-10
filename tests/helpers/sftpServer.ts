/**
 * In-process SFTP test server built on top of ssh2.
 *
 * Uses the OS temp dir as backing storage so tests can verify real file I/O.
 * Generates a fresh RSA host key on each run (no persistent key files needed).
 */
import { Server, utils as sshUtils } from 'ssh2';
import type { Connection, Session, SFTPWrapper } from 'ssh2';
import {
  mkdtempSync,
  readdirSync,
  unlinkSync,
  mkdirSync,
  statSync,
  openSync,
  readSync,
  writeSync,
  closeSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { AddressInfo } from 'net';

export interface TestSftpServer {
  port: number;
  rootDir: string;
  stop(): Promise<void>;
}

// Generate a self-signed host key using ssh2's built-in utilities
function generateHostKey(): Buffer {
  const keypair = sshUtils.generateKeyPairSync('rsa', { bits: 1024 });
  return Buffer.from((keypair as unknown as { private: string }).private);
}

export async function startSftpServer(
  username: string,
  password: string,
): Promise<TestSftpServer> {
  const rootDir = mkdtempSync(join(tmpdir(), 'sftp-test-'));
  const hostKey = generateHostKey();

  const server = new Server({ hostKeys: [hostKey] }, (client: Connection) => {
    client
      .on('authentication', ctx => {
        if (ctx.method === 'password' && ctx.username === username && ctx.password === password) {
          ctx.accept();
        } else {
          ctx.reject(['password']);
        }
      })
      .on('ready', () => {
        client.on('session', (accept: () => Session) => {
          const session = accept();
          session.on('sftp', (accept: () => SFTPWrapper) => {
            const sftp = accept();
            setupSftpHandlers(sftp, rootDir);
          });
        });
      })
      .on('error', () => { /* ignore client errors */ });
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.on('error', reject);
  });

  const port = (server.address() as AddressInfo).port;

  return {
    port,
    rootDir,
    stop: () => new Promise(resolve => server.close(() => resolve())),
  };
}

// ── SFTP subsystem implementation ─────────────────────────────────────────

interface OpenHandle {
  path: string;
  fd: number;
  flags: number;
}

function setupSftpHandlers(sftp: SFTPWrapper, rootDir: string): void {
  // Map handle IDs to open file/dir handles
  const fileHandles = new Map<number, OpenHandle>();
  const dirHandles = new Map<number, { path: string; entries: string[]; pos: number }>();
  let nextHandle = 1;

  const OPEN_MODE = sshUtils.sftp.OPEN_MODE;
  const STATUS_CODE = sshUtils.sftp.STATUS_CODE;

  function resolvePath(p: string): string {
    // Strip leading slash and resolve relative to rootDir
    const rel = p.replace(/^\/+/, '');
    return join(rootDir, rel);
  }

  function makeAttrs(absPath: string) {
    try {
      const st = statSync(absPath);
      return {
        mode: st.isDirectory() ? 0o40755 : 0o100644,
        uid: 0,
        gid: 0,
        size: st.size,
        atime: Math.floor(st.atimeMs / 1000),
        mtime: Math.floor(st.mtimeMs / 1000),
      };
    } catch {
      return null;
    }
  }

  sftp.on('OPEN', (reqid, filename, flags, _attrs) => {
    const absPath = resolvePath(filename);
    try {
      let nodeFlags = 'r';
      if (flags & OPEN_MODE.WRITE) {
        nodeFlags = flags & OPEN_MODE.READ ? 'r+' : 'w';
        if (flags & OPEN_MODE.CREAT) nodeFlags = flags & OPEN_MODE.TRUNC ? 'w' : 'a';
        if (flags & OPEN_MODE.TRUNC) nodeFlags = 'w';
      }

      // Ensure parent directory exists for writes
      if (nodeFlags !== 'r') {
        const parentDir = join(absPath, '..');
        mkdirSync(parentDir, { recursive: true });
      }

      const fd = openSync(absPath, nodeFlags);
      const handleId = nextHandle++;
      fileHandles.set(handleId, { path: absPath, fd, flags });
      sftp.handle(reqid, Buffer.from([handleId]));
    } catch (err) {
      sftp.status(reqid, STATUS_CODE.FAILURE, String(err));
    }
  });

  sftp.on('READ', (reqid, handle, offset, length) => {
    const id = handle[0];
    const h = fileHandles.get(id);
    if (!h) { sftp.status(reqid, STATUS_CODE.FAILURE, 'Bad handle'); return; }
    const buf = Buffer.alloc(length);
    try {
      const bytesRead = readSync(h.fd, buf, 0, length, offset);
      if (bytesRead === 0) {
        sftp.status(reqid, STATUS_CODE.EOF);
      } else {
        sftp.data(reqid, buf.slice(0, bytesRead));
      }
    } catch (err) {
      sftp.status(reqid, STATUS_CODE.FAILURE, String(err));
    }
  });

  sftp.on('WRITE', (reqid, handle, offset, data) => {
    const id = handle[0];
    const h = fileHandles.get(id);
    if (!h) { sftp.status(reqid, STATUS_CODE.FAILURE, 'Bad handle'); return; }
    try {
      writeSync(h.fd, data, 0, data.length, offset);
      sftp.status(reqid, STATUS_CODE.OK);
    } catch (err) {
      sftp.status(reqid, STATUS_CODE.FAILURE, String(err));
    }
  });

  sftp.on('CLOSE', (reqid, handle) => {
    const id = handle[0];
    if (fileHandles.has(id)) {
      try { closeSync(fileHandles.get(id)!.fd); } catch { /* ignore */ }
      fileHandles.delete(id);
      sftp.status(reqid, STATUS_CODE.OK);
    } else if (dirHandles.has(id)) {
      dirHandles.delete(id);
      sftp.status(reqid, STATUS_CODE.OK);
    } else {
      sftp.status(reqid, STATUS_CODE.FAILURE, 'Bad handle');
    }
  });

  sftp.on('OPENDIR', (reqid, path) => {
    const absPath = resolvePath(path);
    try {
      const entries = readdirSync(absPath);
      const handleId = nextHandle++;
      dirHandles.set(handleId, { path: absPath, entries, pos: 0 });
      sftp.handle(reqid, Buffer.from([handleId]));
    } catch (err) {
      sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE, String(err));
    }
  });

  sftp.on('READDIR', (reqid, handle) => {
    const id = handle[0];
    const h = dirHandles.get(id);
    if (!h) { sftp.status(reqid, STATUS_CODE.FAILURE, 'Bad handle'); return; }

    if (h.pos >= h.entries.length) {
      sftp.status(reqid, STATUS_CODE.EOF);
      return;
    }

    // Return remaining entries in one batch
    const names = h.entries.slice(h.pos).map(name => {
      const fullPath = join(h.path, name);
      const attrs = makeAttrs(fullPath) ?? { mode: 0o100644, uid: 0, gid: 0, size: 0, atime: 0, mtime: 0 };
      return {
        filename: name,
        longname: `-rw-r--r-- 1 user group ${attrs.size} Jan 01 00:00 ${name}`,
        attrs,
      };
    });

    h.pos = h.entries.length;
    sftp.name(reqid, names);
  });

  sftp.on('STAT', (reqid, path) => {
    const absPath = resolvePath(path);
    const attrs = makeAttrs(absPath);
    if (!attrs) {
      sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
    } else {
      sftp.attrs(reqid, attrs);
    }
  });

  sftp.on('LSTAT', (reqid, path) => {
    const absPath = resolvePath(path);
    const attrs = makeAttrs(absPath);
    if (!attrs) {
      sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
    } else {
      sftp.attrs(reqid, attrs);
    }
  });

  sftp.on('FSTAT', (reqid, handle) => {
    const id = handle[0];
    const h = fileHandles.get(id);
    if (!h) { sftp.status(reqid, STATUS_CODE.FAILURE, 'Bad handle'); return; }
    const attrs = makeAttrs(h.path);
    if (!attrs) {
      sftp.status(reqid, STATUS_CODE.FAILURE, 'stat failed');
    } else {
      sftp.attrs(reqid, attrs);
    }
  });

  sftp.on('MKDIR', (reqid, path, _attrs) => {
    const absPath = resolvePath(path);
    try {
      mkdirSync(absPath, { recursive: true });
      sftp.status(reqid, STATUS_CODE.OK);
    } catch (err) {
      sftp.status(reqid, STATUS_CODE.FAILURE, String(err));
    }
  });

  sftp.on('REMOVE', (reqid, path) => {
    const absPath = resolvePath(path);
    try {
      unlinkSync(absPath);
      sftp.status(reqid, STATUS_CODE.OK);
    } catch (err) {
      sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE, String(err));
    }
  });

  sftp.on('RMDIR', (reqid, path) => {
    const absPath = resolvePath(path);
    try {
      // Node.js rmdir is synchronous; use fs.rmdirSync
      const { rmdirSync } = require('fs') as typeof import('fs');
      rmdirSync(absPath);
      sftp.status(reqid, STATUS_CODE.OK);
    } catch (err) {
      sftp.status(reqid, STATUS_CODE.FAILURE, String(err));
    }
  });

  sftp.on('RENAME', (reqid, oldPath, newPath) => {
    const absOld = resolvePath(oldPath);
    const absNew = resolvePath(newPath);
    try {
      const { renameSync } = require('fs') as typeof import('fs');
      renameSync(absOld, absNew);
      sftp.status(reqid, STATUS_CODE.OK);
    } catch (err) {
      sftp.status(reqid, STATUS_CODE.FAILURE, String(err));
    }
  });

  sftp.on('REALPATH', (reqid, path) => {
    sftp.name(reqid, [{ filename: path, longname: path, attrs: { mode: 0o40755, uid: 0, gid: 0, size: 0, atime: 0, mtime: 0 } }]);
  });

  sftp.on('SETSTAT', (reqid, _path, _attrs) => {
    sftp.status(reqid, STATUS_CODE.OK);
  });

  sftp.on('FSETSTAT', (reqid, _handle, _attrs) => {
    sftp.status(reqid, STATUS_CODE.OK);
  });
}
