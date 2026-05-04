import type { BackendAdapter, BackendCredentials, FileEntry, ObjectMeta } from '../types/backend.js';

export abstract class BaseAdapter implements BackendAdapter {
  constructor(protected creds: BackendCredentials) {}

  abstract connect(): Promise<void>;

  useBucket(bucket: string): void {
    this.creds = { ...this.creds, bucket };
  }
  abstract listObjects(prefix?: string): Promise<FileEntry[]>;
  abstract getObject(key: string): Promise<Buffer>;
  abstract putObject(key: string, data: Buffer): Promise<void>;
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
