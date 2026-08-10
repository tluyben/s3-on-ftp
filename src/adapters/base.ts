import { Readable, Writable } from 'stream';
import type { BackendAdapter, BackendCredentials, FileEntry, ObjectMeta } from '../types/backend.js';

export abstract class BaseAdapter implements BackendAdapter {
  constructor(protected creds: BackendCredentials) {}

  abstract connect(): Promise<void>;

  useBucket(bucket: string): void {
    this.creds = { ...this.creds, bucket };
  }
  abstract listObjects(prefix?: string): Promise<FileEntry[]>;
  abstract downloadTo(key: string, dest: Writable): Promise<void>;
  abstract uploadFrom(key: string, src: Readable): Promise<void>;

  /**
   * Buffered helpers for callers that genuinely want the whole object in
   * memory (tests, small internal reads). The request path never uses these —
   * it streams — so object size stays independent of available RAM.
   */
  async getObject(key: string): Promise<Buffer> {
    const chunks: Buffer[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        chunks.push(Buffer.from(chunk));
        cb();
      },
    });
    await this.downloadTo(key, sink);
    return Buffer.concat(chunks);
  }

  async putObject(key: string, data: Buffer): Promise<void> {
    await this.uploadFrom(key, Readable.from(data));
  }

  abstract deleteObject(key: string): Promise<void>;
  abstract headObject(key: string): Promise<ObjectMeta>;
  abstract bucketExists(): Promise<boolean>;
  abstract createBucket(): Promise<void>;
  abstract disconnect(): Promise<void>;

  protected remotePath(key?: string): string {
    const base = this.creds.bucket.replace(/\/+$/, '');
    if (!key) return base;
    return `${base}/${key}`.replace(/\/+/g, '/');
  }
}
