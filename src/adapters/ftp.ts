import { Client } from 'basic-ftp';
import { createHash } from 'crypto';
import { PassThrough, Readable } from 'stream';
import type { FileEntry, ObjectMeta } from '../types/backend.js';
import { BaseAdapter } from './base.js';

export class FtpAdapter extends BaseAdapter {
  private client = new Client();

  /** Always return absolute FTP paths to avoid CWD-relative issues. */
  protected override remotePath(key?: string): string {
    const base = `/${this.creds.bucket}`.replace(/\/+/g, '/');
    if (!key) return base;
    return `${base}/${key}`.replace(/\/+/g, '/');
  }

  async connect(): Promise<void> {
    await this.client.access({
      host: this.creds.host,
      port: this.creds.port,
      user: this.creds.username,
      password: this.creds.password,
      secure: false,
    });
  }

  async listObjects(prefix = ''): Promise<FileEntry[]> {
    const dir = prefix ? this.remotePath(prefix) : this.remotePath();
    const list = await this.client.list(dir);
    return list
      .filter(f => f.type === 1) // type 1 = file
      .map(f => ({
        key: prefix ? `${prefix}/${f.name}` : f.name,
        size: f.size ?? 0,
        lastModified: f.modifiedAt ?? new Date(),
        etag: createHash('md5').update(`${f.name}${f.size ?? 0}`).digest('hex'),
      }));
  }

  async getObject(key: string): Promise<Buffer> {
    const pass = new PassThrough();
    const chunks: Buffer[] = [];
    pass.on('data', (chunk: Buffer) => chunks.push(chunk));
    const done = new Promise<void>((resolve, reject) => {
      pass.on('end', resolve);
      pass.on('error', reject);
    });
    await this.client.downloadTo(pass, this.remotePath(key));
    await done;
    return Buffer.concat(chunks);
  }

  async putObject(key: string, data: Buffer): Promise<void> {
    const readable = Readable.from(data);
    await this.client.uploadFrom(readable, this.remotePath(key));
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.remove(this.remotePath(key));
  }

  async headObject(key: string): Promise<ObjectMeta> {
    // List the parent directory to find the file stats
    const parts = key.split('/');
    const filename = parts.pop()!;
    const parentDir = parts.length > 0 ? this.remotePath(parts.join('/')) : this.remotePath();
    const list = await this.client.list(parentDir);
    const f = list.find(item => item.name === filename);
    if (!f || f.type !== 1) {
      throw Object.assign(new Error('NoSuchKey'), { code: 'NoSuchKey' });
    }
    return {
      size: f.size ?? 0,
      lastModified: f.modifiedAt ?? new Date(),
      etag: createHash('md5').update(`${f.name}${f.size ?? 0}`).digest('hex'),
    };
  }

  async bucketExists(): Promise<boolean> {
    try {
      await this.client.list(this.remotePath());
      return true;
    } catch {
      return false;
    }
  }

  async createBucket(): Promise<void> {
    await this.client.ensureDir(this.remotePath());
  }

  async disconnect(): Promise<void> {
    this.client.close();
  }

  isClosed(): boolean {
    return this.client.closed;
  }

  async keepAlive(): Promise<void> {
    if (!this.client.closed) {
      await this.client.send('NOOP');
    }
  }
}
