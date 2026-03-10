export type BackendScheme = 'ftp' | 'sftp' | 'scp';

export interface BackendCredentials {
  scheme: BackendScheme;
  username: string;
  host: string;
  port: number;
  password: string;
  bucket: string;
}

export interface FileEntry {
  key: string;
  size: number;
  lastModified: Date;
  etag: string;
}

export interface ObjectMeta {
  size: number;
  lastModified: Date;
  etag: string;
}

export interface BackendAdapter {
  listObjects(prefix?: string): Promise<FileEntry[]>;
  getObject(key: string): Promise<Buffer>;
  putObject(key: string, data: Buffer): Promise<void>;
  deleteObject(key: string): Promise<void>;
  headObject(key: string): Promise<ObjectMeta>;
  bucketExists(): Promise<boolean>;
  createBucket(): Promise<void>;
  disconnect(): Promise<void>;
}
