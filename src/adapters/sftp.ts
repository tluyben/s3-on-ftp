import { Client } from 'ssh2';
import type { SFTPWrapper, FileEntry as Ssh2FileEntry } from 'ssh2';
import { createHash } from 'crypto';
import type { FileEntry, ObjectMeta } from '../types/backend.js';
import { BaseAdapter } from './base.js';

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

  async listObjects(prefix = ''): Promise<FileEntry[]> {
    const dir = prefix ? this.remotePath(prefix) : this.remotePath();
    return new Promise((resolve, reject) => {
      this.sftp.readdir(dir, (err, list) => {
        if (err) return reject(err);
        const entries: FileEntry[] = (list as Ssh2FileEntry[])
          .filter(f => {
            // Regular file: mode & 0o170000 === 0o100000
            const mode = f.attrs.mode ?? 0;
            return (mode & 0o170000) === 0o100000;
          })
          .map(f => ({
            key: prefix ? `${prefix}/${f.filename}` : f.filename,
            size: f.attrs.size ?? 0,
            lastModified: new Date((f.attrs.mtime ?? 0) * 1000),
            etag: createHash('md5').update(`${f.filename}${f.attrs.size ?? 0}`).digest('hex'),
          }));
        resolve(entries);
      });
    });
  }

  async getObject(key: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const stream = this.sftp.createReadStream(this.remotePath(key));
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  }

  async putObject(key: string, data: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      const stream = this.sftp.createWriteStream(this.remotePath(key));
      stream.on('close', resolve);
      stream.on('error', reject);
      stream.end(data);
    });
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
