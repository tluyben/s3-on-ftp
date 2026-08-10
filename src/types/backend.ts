import type { Readable, Writable } from 'stream';

export type BackendScheme = 'ftp' | 'sftp' | 'scp';

export interface BackendCredentials {
  scheme: BackendScheme;
  username: string;
  host: string;
  port: number;
  password: string;
  bucket: string;
  maxConnections?: number;
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

  /**
   * Stream an object out of the backend into `dest`, resolving only once the
   * transfer is complete. `dest` is ended by the transfer.
   *
   * Streaming (rather than returning a Buffer) is the primary path: object
   * bodies are never held in memory, so transfer size is bounded by the backend
   * and the socket, not by RAM.
   */
  downloadTo(key: string, dest: Writable): Promise<void>;

  /** Stream `src` into the backend, resolving once the object is fully stored. */
  uploadFrom(key: string, src: Readable): Promise<void>;

  /** Buffered convenience wrappers, implemented over the streaming methods. */
  getObject(key: string): Promise<Buffer>;
  putObject(key: string, data: Buffer): Promise<void>;

  deleteObject(key: string): Promise<void>;
  headObject(key: string): Promise<ObjectMeta>;
  bucketExists(): Promise<boolean>;
  createBucket(): Promise<void>;
  disconnect(): Promise<void>;
}
