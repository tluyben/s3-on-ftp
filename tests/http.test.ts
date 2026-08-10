/**
 * HTTP-layer integration tests: the real Express app driven over a real socket,
 * backed by the in-process SFTP test server.
 *
 * The adapter tests exercise backends directly and so cannot catch defects in
 * middleware or request parsing — the layer every S3 client actually talks to.
 */
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { createHash } from 'crypto';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { startSftpServer, type TestSftpServer } from './helpers/sftpServer.js';
import { createApp } from '../src/app.js';
import { closeAllPools } from '../src/utils/connectionPool.js';

const USERNAME = 'testuser';
const PASSWORD = 'testpass123';
const BUCKET = 'httpbucket';

describe('S3 HTTP API', () => {
  let sftp: TestSftpServer;
  let server: Server;
  let base: string;
  let accessKey: string;

  beforeAll(async () => {
    sftp = await startSftpServer(USERNAME, PASSWORD);
    accessKey = `sftp://${USERNAME}@127.0.0.1:${sftp.port}`;

    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const mk = await call('PUT', `/${BUCKET}`);
    expect(mk.status).toBe(200);
  }, 30_000);

  afterAll(async () => {
    await closeAllPools(); // release backend sockets first, or stop() hangs
    server.closeAllConnections(); // drop idle HTTP keep-alive sockets
    await new Promise<void>(resolve => server.close(() => resolve()));
    await sftp.stop();
  }, 15_000);

  /** Builds the Authorization header exactly as an AWS SDK does: key NOT encoded. */
  function authHeader(): string {
    return `AWS4-HMAC-SHA256 Credential=${accessKey}/20260310/us-east-1/s3/aws4_request, SignedHeaders=host, Signature=abc`;
  }

  async function call(
    method: string,
    path: string,
    opts: { body?: Buffer; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; headers: Headers; body: Buffer }> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: authHeader(),
        'x-amz-security-token': PASSWORD,
        ...(opts.headers ?? {}),
      },
      body: opts.body,
    });
    return { status: res.status, headers: res.headers, body: Buffer.from(await res.arrayBuffer()) };
  }

  it('serves the health check without credentials', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('healthy');
  });

  it('accepts the raw, unencoded access key an AWS SDK sends', async () => {
    const res = await call('HEAD', `/${BUCKET}`);
    expect(res.status).toBe(200);
  });

  // Regression: body-parser's '*/*' matcher returns false when the request has
  // NO Content-Type, which left req.body as {} and corrupted every such upload.
  it('stores a PUT body sent WITHOUT a Content-Type header', async () => {
    const payload = Buffer.from('no content-type header here');
    const put = await call('PUT', `/${BUCKET}/no-ct.txt`, { body: payload });
    expect(put.status).toBe(200);
    expect(put.headers.get('etag')).toBe(`"${createHash('md5').update(payload).digest('hex')}"`);

    const get = await call('GET', `/${BUCKET}/no-ct.txt`);
    expect(get.body.equals(payload)).toBe(true);
  });

  it('stores a PUT body sent WITH a Content-Type header', async () => {
    const payload = Buffer.from('with content-type');
    const put = await call('PUT', `/${BUCKET}/with-ct.txt`, {
      body: payload,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    expect(put.status).toBe(200);

    const get = await call('GET', `/${BUCKET}/with-ct.txt`);
    expect(get.body.equals(payload)).toBe(true);
  });

  it('round-trips binary data byte-for-byte', async () => {
    const bin = Buffer.alloc(64 * 1024);
    for (let i = 0; i < bin.length; i++) bin[i] = (i * 31) & 0xff;
    expect((await call('PUT', `/${BUCKET}/bin.dat`, { body: bin })).status).toBe(200);
    expect((await call('GET', `/${BUCKET}/bin.dat`)).body.equals(bin)).toBe(true);
  });

  // Regression: nested keys need their parent directories created first.
  it('stores and retrieves a nested key, creating parent directories', async () => {
    const payload = Buffer.from('deeply nested');
    const put = await call('PUT', `/${BUCKET}/a/b/c/nested.txt`, { body: payload });
    expect(put.status).toBe(200);

    const get = await call('GET', `/${BUCKET}/a/b/c/nested.txt`);
    expect(get.status).toBe(200);
    expect(get.body.equals(payload)).toBe(true);
  });

  // Listing is recursive, matching putfile-cloud's listObjectsInDirectory():
  // nested files appear as flat keys containing slashes, not as directories.
  it('lists nested objects recursively as slash-separated keys', async () => {
    await call('PUT', `/${BUCKET}/deep/one.txt`, { body: Buffer.from('1') });
    await call('PUT', `/${BUCKET}/deep/deeper/two.txt`, { body: Buffer.from('2') });

    const xml = (await call('GET', `/${BUCKET}`)).body.toString();
    expect(xml).toContain('<Key>deep/one.txt</Key>');
    expect(xml).toContain('<Key>deep/deeper/two.txt</Key>');
    // Directories themselves are not objects.
    expect(xml).not.toContain('<Key>deep</Key>');
  });

  it('scopes a recursive listing to the requested prefix', async () => {
    const xml = (await call('GET', `/${BUCKET}?prefix=deep/deeper`)).body.toString();
    expect(xml).toContain('<Key>deep/deeper/two.txt</Key>');
    expect(xml).not.toContain('<Key>deep/one.txt</Key>');
  });

  it('lists objects and reports them in ListObjectsV2 XML', async () => {
    const res = await call('GET', `/${BUCKET}?list-type=2`);
    expect(res.status).toBe(200);
    expect(res.body.toString()).toContain('<Key>no-ct.txt</Key>');
    expect(res.body.toString()).toContain('<KeyCount>');
  });

  it('reports object size via HeadObject', async () => {
    const res = await call('HEAD', `/${BUCKET}/with-ct.txt`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe(String('with content-type'.length));
  });

  it('returns 403 when the Authorization header is absent', async () => {
    const res = await fetch(`${base}/${BUCKET}`);
    expect(res.status).toBe(403);
  });

  it('returns 403 for a non-ftp/sftp/scp access key scheme', async () => {
    const res = await fetch(`${base}/${BUCKET}`, {
      headers: {
        Authorization:
          'AWS4-HMAC-SHA256 Credential=https://user@host/20260310/us-east-1/s3/aws4_request, Signature=x',
        'x-amz-security-token': PASSWORD,
      },
    });
    expect(res.status).toBe(403);
  });

  // Regression: "not found" was matched on server-specific English text, so
  // backends phrasing it differently produced a 500 instead of a 404.
  it('returns 404 NoSuchKey for a missing object', async () => {
    const res = await call('GET', `/${BUCKET}/definitely-missing.txt`);
    expect(res.status).toBe(404);
    expect(res.body.toString()).toContain('<Code>NoSuchKey</Code>');
  });

  it('returns 404 NoSuchBucket for a missing bucket listing', async () => {
    const res = await call('GET', '/no-such-bucket-here');
    expect(res.status).toBe(404);
    expect(res.body.toString()).toContain('<Code>NoSuchBucket</Code>');
  });

  it('returns 409 when creating a bucket that already exists', async () => {
    const res = await call('PUT', `/${BUCKET}`);
    expect(res.status).toBe(409);
  });

  it('deletes an object and then reports it missing', async () => {
    expect((await call('DELETE', `/${BUCKET}/with-ct.txt`)).status).toBe(204);
    expect((await call('GET', `/${BUCKET}/with-ct.txt`)).status).toBe(404);
  });

  it('handles concurrent requests over the connection pool', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, async (_, i) => {
        const payload = Buffer.from(`payload-${i}-`.repeat(50));
        const put = await call('PUT', `/${BUCKET}/conc-${i}.txt`, { body: payload });
        if (put.status !== 200) return false;
        const get = await call('GET', `/${BUCKET}/conc-${i}.txt`);
        return get.body.equals(payload);
      }),
    );
    expect(results.every(Boolean)).toBe(true);
  }, 30_000);
});
