import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { startSftpServer, type TestSftpServer } from './helpers/sftpServer.js';
import { SftpAdapter } from '../src/adapters/sftp.js';

const USERNAME = 'testuser';
const PASSWORD = 'testpass123';
const BUCKET = 'mybucket';

describe('SftpAdapter', () => {
  let server: TestSftpServer;
  let adapter: SftpAdapter;

  beforeAll(async () => {
    server = await startSftpServer(USERNAME, PASSWORD);

    adapter = new SftpAdapter({
      scheme: 'sftp',
      host: '127.0.0.1',
      port: server.port,
      username: USERNAME,
      password: PASSWORD,
      bucket: BUCKET,
    });
    await adapter.connect();
    // Create the test bucket (directory)
    await adapter.createBucket();
  }, 30_000);

  afterAll(async () => {
    await adapter.disconnect();
    await server.stop();
  }, 10_000);

  it('bucketExists returns true after createBucket', async () => {
    expect(await adapter.bucketExists()).toBe(true);
  });

  it('putObject stores a file', async () => {
    await adapter.putObject('hello.txt', Buffer.from('hello world'));
  });

  it('getObject retrieves the file', async () => {
    const data = await adapter.getObject('hello.txt');
    expect(data.toString()).toBe('hello world');
  });

  it('headObject returns correct size', async () => {
    const meta = await adapter.headObject('hello.txt');
    expect(meta.size).toBe(11);
  });

  it('listObjects includes the uploaded file', async () => {
    const entries = await adapter.listObjects();
    const found = entries.find(e => e.key === 'hello.txt');
    expect(found).toBeDefined();
    expect(found?.size).toBe(11);
  });

  it('putObject / getObject round-trip with binary data', async () => {
    const binary = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd]);
    await adapter.putObject('binary.bin', binary);
    const result = await adapter.getObject('binary.bin');
    expect(result).toEqual(binary);
  });

  it('deleteObject removes the file', async () => {
    await adapter.deleteObject('hello.txt');
    const entries = await adapter.listObjects();
    expect(entries.find(e => e.key === 'hello.txt')).toBeUndefined();
  });

  it('headObject throws for missing key', async () => {
    await expect(adapter.headObject('does-not-exist.txt')).rejects.toThrow();
  });
});
