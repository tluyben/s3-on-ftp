import { Client, FileType } from 'basic-ftp';
import { createHash } from 'crypto';
import { Readable, type Writable } from 'stream';
import type { FileEntry, ObjectMeta } from '../types/backend.js';
import { BaseAdapter } from './base.js';

/** Safety net against pathological trees; real buckets are far shallower. */
const MAX_LIST_DEPTH = 32;

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

  /**
   * Recursively collect every file under `dir`, keyed by its path relative to
   * the bucket. S3 keys are flat strings containing slashes, so a shallow
   * listing would hide every nested object.
   */
  private async walk(dir: string, keyPrefix: string, depth: number): Promise<FileEntry[]> {
    if (depth > MAX_LIST_DEPTH) return [];

    const list = await this.client.list(dir);
    const entries: FileEntry[] = [];

    for (const f of list) {
      if (f.name === '.' || f.name === '..') continue;

      const key = keyPrefix ? `${keyPrefix}/${f.name}` : f.name;

      if (f.type === FileType.File) {
        entries.push({
          key,
          size: f.size ?? 0,
          lastModified: f.modifiedAt ?? new Date(),
          etag: createHash('md5').update(`${f.name}${f.size ?? 0}`).digest('hex'),
        });
      } else if (f.type === FileType.Directory) {
        // Symlinks are not followed — they can form cycles.
        entries.push(...await this.walk(`${dir}/${f.name}`, key, depth + 1));
      }
    }

    return entries;
  }

  async listObjects(prefix = ''): Promise<FileEntry[]> {
    const dir = prefix ? this.remotePath(prefix) : this.remotePath();
    return this.walk(dir, prefix, 0);
  }

  /**
   * Streams the remote file straight into `dest`. basic-ftp pipes the data
   * socket to the destination, so nothing is buffered and the promise resolves
   * only once the transfer completes (which is what keeps the pooled
   * connection checked out for the whole transfer).
   */
  async downloadTo(key: string, dest: Writable): Promise<void> {
    await this.client.downloadTo(dest, this.remotePath(key));
  }

  /** Streams `src` straight to the remote file — nothing is buffered. */
  async uploadFrom(key: string, src: Readable): Promise<void> {
    // S3 keys are flat strings: `a/b/c.txt` implies directories that FTP will
    // not create on its own, so materialise them before uploading.
    const full = this.remotePath(key);
    if (key.includes('/')) {
      await this.client.ensureDir(full.slice(0, full.lastIndexOf('/')));
    }
    await this.client.uploadFrom(src, full);
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
    if (!f || f.type !== FileType.File) {
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
