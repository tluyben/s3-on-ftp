import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { startFtpServer, type TestFtpServer } from './helpers/ftpServer.js';
import { FtpAdapter } from '../src/adapters/ftp.js';

const USERNAME = 'ftpuser';
const PASSWORD = 'ftppass123';
const BUCKET = 'ftpbucket';

describe('FtpAdapter', () => {
  let server: TestFtpServer;
  let adapter: FtpAdapter;

  beforeAll(async () => {
    server = await startFtpServer(USERNAME, PASSWORD);

    adapter = new FtpAdapter({
      scheme: 'ftp',
      host: '127.0.0.1',
      port: server.port,
      username: USERNAME,
      password: PASSWORD,
      bucket: BUCKET,
    });
    await adapter.connect();
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
    await adapter.putObject('greet.txt', Buffer.from('hello ftp'));
  });

  it('getObject retrieves the file', async () => {
    const data = await adapter.getObject('greet.txt');
    expect(data.toString()).toBe('hello ftp');
  });

  it('listObjects includes the uploaded file', async () => {
    const entries = await adapter.listObjects();
    const found = entries.find(e => e.key === 'greet.txt');
    expect(found).toBeDefined();
  });

  it('headObject returns correct size', async () => {
    const meta = await adapter.headObject('greet.txt');
    expect(meta.size).toBe(9);
  });

  it('putObject / getObject round-trip', async () => {
    const content = 'round-trip test content 123';
    await adapter.putObject('roundtrip.txt', Buffer.from(content));
    const result = await adapter.getObject('roundtrip.txt');
    expect(result.toString()).toBe(content);
  });

  it('deleteObject removes the file', async () => {
    await adapter.deleteObject('greet.txt');
    const entries = await adapter.listObjects();
    expect(entries.find(e => e.key === 'greet.txt')).toBeUndefined();
  });
});
