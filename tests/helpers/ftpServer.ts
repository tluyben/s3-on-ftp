/**
 * Minimal in-process FTP server for integration tests.
 *
 * Implements only the commands used by basic-ftp:
 *   USER, PASS, TYPE, FEAT, OPTS, SYST, PWD, CWD, PASV, EPSV,
 *   LIST, NLST, STOR, RETR, DELE, MKD, RMD, QUIT, NOOP, SIZE, MDTM
 *
 * Zero external dependencies — no vulnerable `ip` package.
 */
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface TestFtpServer {
  port: number;
  rootDir: string;
  stop(): Promise<void>;
}

export async function startFtpServer(
  username: string,
  password: string,
): Promise<TestFtpServer> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftp-test-'));

  const server = net.createServer(socket => {
    handleClient(socket, username, password, rootDir);
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.on('error', reject);
  });

  const port = (server.address() as net.AddressInfo).port;

  return {
    port,
    rootDir,
    stop: () => new Promise(resolve => server.close(() => resolve())),
  };
}

// ── Client handler ─────────────────────────────────────────────────────────

interface ClientState {
  authenticated: boolean;
  user: string | null;
  cwd: string;      // relative to rootDir
  dataServer: net.Server | null;
  dataPort: number;
  dataHost: string;
  binaryMode: boolean;
  // Buffer connections that arrive before openDataConn() is called
  pendingConn: net.Socket | null;
  pendingConnResolve: ((s: net.Socket) => void) | null;
}

function handleClient(
  ctrl: net.Socket,
  validUser: string,
  validPass: string,
  rootDir: string,
): void {
  const state: ClientState = {
    authenticated: false,
    user: null,
    cwd: '/',
    dataServer: null,
    dataPort: 0,
    dataHost: '127.0.0.1',
    binaryMode: true,
    pendingConn: null,
    pendingConnResolve: null,
  };

  let buf = '';

  const send = (line: string) => {
    ctrl.write(line + '\r\n');
  };

  const resolvePath = (p: string): string => {
    const abs = p.startsWith('/') ? p : path.posix.join(state.cwd, p);
    const normalised = path.posix.normalize(abs);
    return path.join(rootDir, normalised);
  };

  // Returns a data connection, consuming a pre-buffered one if it already arrived.
  const openDataConn = (): Promise<net.Socket> => {
    if (state.pendingConn) {
      const sock = state.pendingConn;
      state.pendingConn = null;
      return Promise.resolve(sock);
    }
    return new Promise((resolve, reject) => {
      if (!state.dataServer) {
        reject(new Error('No passive mode server'));
        return;
      }
      state.pendingConnResolve = resolve;
      state.dataServer.once('error', reject);
    });
  };

  const setupPassive = (): Promise<void> => {
    return new Promise((resolve, reject) => {
      // Close any previous passive server
      if (state.dataServer) {
        state.dataServer.close();
        state.dataServer = null;
      }
      state.pendingConn = null;
      state.pendingConnResolve = null;

      const srv = net.createServer((sock: net.Socket) => {
        // Connection arrived — deliver to waiter or buffer it
        if (state.pendingConnResolve) {
          const res = state.pendingConnResolve;
          state.pendingConnResolve = null;
          res(sock);
        } else {
          state.pendingConn = sock;
        }
      });
      srv.listen(0, '127.0.0.1', () => {
        state.dataServer = srv;
        state.dataPort = (srv.address() as net.AddressInfo).port;
        state.dataHost = '127.0.0.1';
        resolve();
      });
      srv.on('error', reject);
    });
  };

  send('220 Minimal FTP Server Ready');

  ctrl.on('data', (chunk: Buffer) => {
    buf += chunk.toString('ascii');
    let idx: number;
    while ((idx = buf.indexOf('\r\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 2);
      if (line) void processCommand(line);
    }
  });

  ctrl.on('error', () => { /* ignore */ });
  ctrl.on('close', () => {
    if (state.dataServer) {
      state.dataServer.close();
      state.dataServer = null;
    }
  });

  const processCommand = async (line: string): Promise<void> => {
    const spaceIdx = line.indexOf(' ');
    const cmd = (spaceIdx === -1 ? line : line.slice(0, spaceIdx)).toUpperCase();
    const arg = spaceIdx === -1 ? '' : line.slice(spaceIdx + 1).trim();

    switch (cmd) {
      case 'USER':
        state.user = arg;
        send('331 Password required');
        break;

      case 'PASS':
        if (state.user === validUser && arg === validPass) {
          state.authenticated = true;
          send('230 Login successful');
        } else {
          send('530 Login incorrect');
        }
        break;

      case 'QUIT':
        send('221 Goodbye');
        ctrl.end();
        break;

      case 'NOOP':
        send('200 OK');
        break;

      case 'SYST':
        send('215 UNIX Type: L8');
        break;

      case 'FEAT':
        send('211-Features:\r\n SIZE\r\n MDTM\r\n UTF8\r\n211 End');
        break;

      case 'OPTS':
        send('200 OK');
        break;

      case 'TYPE':
        state.binaryMode = arg.toUpperCase() !== 'A';
        send('200 Type set');
        break;

      case 'PWD':
      case 'XPWD':
        send(`257 "${state.cwd}" is current directory`);
        break;

      case 'CWD':
      case 'XCWD': {
        const target = resolvePath(arg || '/');
        try {
          fs.statSync(target);
          state.cwd = path.posix.normalize(
            arg.startsWith('/') ? arg : path.posix.join(state.cwd, arg)
          );
          send('250 Directory changed');
        } catch {
          send('550 No such directory');
        }
        break;
      }

      case 'MKD':
      case 'XMKD': {
        const dir = resolvePath(arg);
        try {
          fs.mkdirSync(dir, { recursive: true });
          send(`257 "${arg}" created`);
        } catch (e) {
          send(`550 Cannot create: ${e}`);
        }
        break;
      }

      case 'RMD':
      case 'XRMD': {
        const dir = resolvePath(arg);
        try {
          fs.rmdirSync(dir);
          send('250 Directory removed');
        } catch (e) {
          send(`550 Cannot remove: ${e}`);
        }
        break;
      }

      case 'DELE': {
        const file = resolvePath(arg);
        try {
          fs.unlinkSync(file);
          send('250 File deleted');
        } catch {
          send('550 File not found');
        }
        break;
      }

      case 'SIZE': {
        const file = resolvePath(arg);
        try {
          const st = fs.statSync(file);
          send(`213 ${st.size}`);
        } catch {
          send('550 File not found');
        }
        break;
      }

      case 'MDTM': {
        const file = resolvePath(arg);
        try {
          const st = fs.statSync(file);
          const d = st.mtime;
          const ts = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
          send(`213 ${ts}`);
        } catch {
          send('550 File not found');
        }
        break;
      }

      case 'PASV': {
        await setupPassive();
        const p1 = Math.floor(state.dataPort / 256);
        const p2 = state.dataPort % 256;
        send(`227 Entering Passive Mode (127,0,0,1,${p1},${p2})`);
        break;
      }

      case 'EPSV': {
        await setupPassive();
        send(`229 Entering Extended Passive Mode (|||${state.dataPort}|)`);
        break;
      }

      case 'LIST':
      case 'NLST': {
        const dir = arg ? resolvePath(arg) : resolvePath(state.cwd);
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          send('550 No such directory');
          break;
        }
        send('150 Opening data connection');
        const dataSock = await openDataConn();
        const lines = entries.map(e => {
          if (cmd === 'NLST') return e.name;
          try {
            const st = fs.statSync(path.join(dir, e.name));
            const mode = e.isDirectory() ? 'drwxr-xr-x' : '-rw-r--r--';
            const d = st.mtime;
            const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
            return `${mode} 1 ftp ftp ${st.size.toString().padStart(12)} ${mon} ${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} ${e.name}`;
          } catch {
            return `-rw-r--r-- 1 ftp ftp            0 Jan  1 00:00 ${e.name}`;
          }
        });
        dataSock.end(lines.join('\r\n') + (lines.length ? '\r\n' : ''));
        await new Promise<void>(r => dataSock.on('close', r));
        send('226 Transfer complete');
        break;
      }

      case 'RETR': {
        const file = resolvePath(arg);
        let data: Buffer;
        try {
          data = fs.readFileSync(file);
        } catch {
          send('550 File not found');
          break;
        }
        send('150 Opening data connection');
        const dataSock = await openDataConn();
        dataSock.end(data);
        await new Promise<void>(r => dataSock.on('close', r));
        send('226 Transfer complete');
        break;
      }

      case 'STOR': {
        const file = resolvePath(arg);
        // Ensure parent dir exists
        fs.mkdirSync(path.dirname(file), { recursive: true });
        send('150 Opening data connection');
        const dataSock = await openDataConn();
        const chunks: Buffer[] = [];
        dataSock.on('data', (c: Buffer) => chunks.push(c));
        await new Promise<void>(r => dataSock.on('close', r));
        fs.writeFileSync(file, Buffer.concat(chunks));
        send('226 Transfer complete');
        break;
      }

      default:
        send(`502 Command "${cmd}" not implemented`);
    }
  };
}

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}
