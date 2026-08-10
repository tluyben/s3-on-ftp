import { Client } from 'ssh2';
import type { SFTPWrapper, FileEntry as Ssh2FileEntry } from 'ssh2';
import { createHash } from 'crypto';
import type { Readable, Writable } from 'stream';
import { pipeline } from 'stream/promises';
import type { FileEntry, ObjectMeta } from '../types/backend.js';
import { BaseAdapter } from './base.js';

/** Safety net against pathological trees; real buckets are far shallower. */
const MAX_LIST_DEPTH = 32;

/**
 * Per-chunk transfer size. SFTP reads/writes are request-response per packet,
 * so a larger window than the 64 KB stream default meaningfully improves
 * throughput on high-latency links without holding the object in memory.
 */
const STREAM_CHUNK_SIZE = 256 * 1024;

export class SftpAdapter extends BaseAdapter {
  protected conn = new Client();
  protected sftp!: SFTPWrapper;
  private _connected = false;

  isConnected(): boolean {
    return this._connected;
  }

  async connect(): Promise<void> {
    this.conn = new Client();
    this._connected = false;
    return new Promise((resolve, reject) => {
      this.conn
        .on('ready', () => {
          this.conn.sftp((err, sftp) => {
            if (err) return reject(err);
            this.sftp = sftp;
            this._connected = true;
            resolve();
          });
        })
        .on('error', reject)
        .on('close', () => { this._connected = false; })
        .connect({
          host: this.creds.host,
          port: this.creds.port,
          username: this.creds.username,
          password: this.creds.password,
          hostVerifier: () => true,
          keepaliveInterval: 30_000,
          keepaliveCountMax: 5,
        });
    });
  }

  private readdir(dir: string): Promise<Ssh2FileEntry[]> {
    return new Promise((resolve, reject) => {
      this.sftp.readdir(dir, (err, list) => (err ? reject(err) : resolve(list as Ssh2FileEntry[])));
    });
  }

  /**
   * Recursively collect every regular file under `dir`, keyed by its path
   * relative to the bucket. S3 has no directories — a nested file is just a key
   * containing slashes — so a non-recursive listing would hide most objects.
   */
  private async walk(dir: string, keyPrefix: string, depth: number): Promise<FileEntry[]> {
    if (depth > MAX_LIST_DEPTH) return [];

    const list = await this.readdir(dir);
    const entries: FileEntry[] = [];

    for (const f of list) {
      // Many SFTP servers include '.' and '..'; recursing into them never ends.
      if (f.filename === '.' || f.filename === '..') continue;

      const key = keyPrefix ? `${keyPrefix}/${f.filename}` : f.filename;
      const mode = f.attrs.mode ?? 0;
      const type = mode & 0o170000;

      if (type === 0o100000) {
        entries.push({
          key,
          size: f.attrs.size ?? 0,
          lastModified: new Date((f.attrs.mtime ?? 0) * 1000),
          etag: createHash('md5').update(`${f.filename}${f.attrs.size ?? 0}`).digest('hex'),
        });
      } else if (type === 0o040000) {
        // Symlinks (0o120000) are deliberately not followed — they can form cycles.
        entries.push(...await this.walk(`${dir}/${f.filename}`, key, depth + 1));
      }
    }

    return entries;
  }

  async listObjects(prefix = ''): Promise<FileEntry[]> {
    const dir = prefix ? this.remotePath(prefix) : this.remotePath();
    return this.walk(dir, prefix, 0);
  }

  /** Streams the remote file straight into `dest` — nothing is buffered. */
  async downloadTo(key: string, dest: Writable): Promise<void> {
    const source = this.sftp.createReadStream(this.remotePath(key), {
      highWaterMark: STREAM_CHUNK_SIZE,
    });
    await pipeline(source, dest);
  }

  /**
   * `mkdir -p` over SFTP. S3 keys are flat strings, so `a/b/c.txt` implies
   * directories the backend does not create on its own. Per-level errors are
   * ignored (EEXIST, or a concurrent writer winning the race) — a genuinely
   * unwritable path surfaces when the file write itself fails.
   */
  private async mkdirp(dir: string): Promise<void> {
    const absolute = dir.startsWith('/');
    const parts = dir.split('/').filter(Boolean);
    let cur = '';
    for (const part of parts) {
      cur = cur ? `${cur}/${part}` : (absolute ? `/${part}` : part);
      const path = cur;
      await new Promise<void>(resolve => {
        this.sftp.mkdir(path, () => resolve());
      });
    }
  }

  /** Streams `src` straight to the remote file — nothing is buffered. */
  async uploadFrom(key: string, src: Readable): Promise<void> {
    if (key.includes('/')) {
      const full = this.remotePath(key);
      await this.mkdirp(full.slice(0, full.lastIndexOf('/')));
    }
    const dest = this.sftp.createWriteStream(this.remotePath(key), {
      highWaterMark: STREAM_CHUNK_SIZE,
    });
    await pipeline(src, dest);
  }

  async deleteObject(key: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sftp.unlink(this.remotePath(key), err => (err ? reject(err) : resolve()));
    });
  }

  async headObject(key: string): Promise<ObjectMeta> {
    return new Promise((resolve, reject) => {
      this.sftp.stat(this.remotePath(key), (err, stats) => {
        if (err) return reject(Object.assign(new Error('NoSuchKey'), { code: 'NoSuchKey' }));
        resolve({
          size: stats.size ?? 0,
          lastModified: new Date((stats.mtime ?? 0) * 1000),
          etag: createHash('md5').update(`${key}${stats.size ?? 0}`).digest('hex'),
        });
      });
    });
  }

  async bucketExists(): Promise<boolean> {
    return new Promise(resolve => {
      this.sftp.stat(this.remotePath(), err => resolve(!err));
    });
  }

  async createBucket(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sftp.mkdir(this.remotePath(), err => (err ? reject(err) : resolve()));
    });
  }

  async disconnect(): Promise<void> {
    this._connected = false;
    try { this.sftp.end(); } catch { /* ignore */ }
    this.conn.end();
  }
}
