/**
 * Streaming behaviour: aws-chunked decoding, streaming crypto, and the
 * property that actually matters — memory does not scale with object size.
 */
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { createHash, generateKeyPairSync, createPublicKey, createPrivateKey } from 'crypto';
import { Readable, Writable } from 'stream';
import { pipeline } from 'stream/promises';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { startSftpServer, type TestSftpServer } from './helpers/sftpServer.js';
import { createApp } from '../src/app.js';
import { closeAllPools } from '../src/utils/connectionPool.js';
import { createAwsChunkedDecoder, isAwsChunked } from '../src/utils/awsChunked.js';
import {
  createEncryptStream,
  createDecryptStream,
  encryptData,
  decryptData,
  encryptionOverhead,
} from '../src/utils/encryption.js';

const USERNAME = 'testuser';
const PASSWORD = 'testpass123';
const BUCKET = 'streambucket';

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks);
}

/** Frames `payload` the way an S3 client streaming a SigV4 upload would. */
function awsChunkFrame(payload: Buffer, chunkSize: number): Buffer {
  const parts: Buffer[] = [];
  const sig = 'a'.repeat(64);
  for (let i = 0; i < payload.length; i += chunkSize) {
    const slice = payload.subarray(i, i + chunkSize);
    parts.push(Buffer.from(`${slice.length.toString(16)};chunk-signature=${sig}\r\n`));
    parts.push(slice, Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`0;chunk-signature=${sig}\r\n\r\n`));
  return Buffer.concat(parts);
}

describe('aws-chunked decoding', () => {
  it('detects framed requests by header', () => {
    expect(isAwsChunked({ 'content-encoding': 'aws-chunked' })).toBe(true);
    expect(isAwsChunked({ 'x-amz-content-sha256': 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD' })).toBe(true);
    expect(isAwsChunked({ 'content-type': 'application/octet-stream' })).toBe(false);
  });

  it('strips chunk framing and restores the exact payload', async () => {
    const payload = Buffer.from('the quick brown fox '.repeat(500));
    const framed = awsChunkFrame(payload, 1024);
    const out = await collect(Readable.from(framed).pipe(createAwsChunkedDecoder()));
    expect(out.equals(payload)).toBe(true);
  });

  it('decodes correctly when network chunks split the framing arbitrarily', async () => {
    const payload = Buffer.from('boundary-splitting payload '.repeat(200));
    const framed = awsChunkFrame(payload, 300);

    // Feed 7 bytes at a time so chunk headers straddle transform() calls.
    const dribble = Readable.from((function* () {
      for (let i = 0; i < framed.length; i += 7) yield framed.subarray(i, i + 7);
    })());

    const out = await collect(dribble.pipe(createAwsChunkedDecoder()));
    expect(out.equals(payload)).toBe(true);
  });

  it('handles a zero-length framed body', async () => {
    const out = await collect(Readable.from(awsChunkFrame(Buffer.alloc(0), 64)).pipe(createAwsChunkedDecoder()));
    expect(out.length).toBe(0);
  });

  it('rejects a truncated framed body', async () => {
    const framed = awsChunkFrame(Buffer.from('abcdef'), 64).subarray(0, 20);
    await expect(collect(Readable.from(framed).pipe(createAwsChunkedDecoder()))).rejects.toThrow();
  });
});

describe('streaming encryption', () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const pub = createPublicKey(publicKey);
  const priv = createPrivateKey(privateKey);

  it('round-trips through encrypt → decrypt streams', async () => {
    const payload = Buffer.from('streamed secret '.repeat(1000));
    const enc = await collect(Readable.from(payload).pipe(createEncryptStream(pub)));
    const dec = await collect(Readable.from(enc).pipe(createDecryptStream(priv)));
    expect(dec.equals(payload)).toBe(true);
  });

  // The streaming and buffered paths must produce the same container, or
  // putfile-cloud compatibility would depend on which path wrote the object.
  it('stream-encrypted output decrypts with the buffered decryptData()', async () => {
    const payload = Buffer.from('written by the stream path');
    const enc = await collect(Readable.from(payload).pipe(createEncryptStream(pub)));
    expect(decryptData(enc, priv).equals(payload)).toBe(true);
  });

  it('buffer-encrypted output decrypts with the streaming decrypt', async () => {
    const payload = Buffer.from('written by the buffered path');
    const dec = await collect(Readable.from(encryptData(payload, pub)).pipe(createDecryptStream(priv)));
    expect(dec.equals(payload)).toBe(true);
  });

  it('produces a container of exactly plaintext + overhead', async () => {
    const payload = Buffer.alloc(4096, 7);
    const enc = await collect(Readable.from(payload).pipe(createEncryptStream(pub)));
    expect(enc.length).toBe(payload.length + encryptionOverhead(pub));
  });

  it('handles an empty payload', async () => {
    const enc = await collect(Readable.from(Buffer.alloc(0)).pipe(createEncryptStream(pub)));
    expect(enc.length).toBe(encryptionOverhead(pub));
    expect((await collect(Readable.from(enc).pipe(createDecryptStream(priv)))).length).toBe(0);
  });

  it('survives payloads split across many small chunks', async () => {
    const payload = Buffer.from('chunky'.repeat(5000));
    const dribble = Readable.from((function* () {
      for (let i = 0; i < payload.length; i += 13) yield payload.subarray(i, i + 13);
    })());
    const enc = await collect(dribble.pipe(createEncryptStream(pub)));
    expect((await collect(Readable.from(enc).pipe(createDecryptStream(priv)))).equals(payload)).toBe(true);
  });

  it('fails the stream when the ciphertext is tampered with', async () => {
    const enc = await collect(Readable.from(Buffer.from('integrity')).pipe(createEncryptStream(pub)));
    enc[enc.length - 1] ^= 0xff; // corrupt the trailing auth tag
    await expect(collect(Readable.from(enc).pipe(createDecryptStream(priv)))).rejects.toThrow();
  });

  it('fails when the container is truncated', async () => {
    const enc = await collect(Readable.from(Buffer.from('short')).pipe(createEncryptStream(pub)));
    await expect(
      collect(Readable.from(enc.subarray(0, enc.length - 4)).pipe(createDecryptStream(priv))),
    ).rejects.toThrow();
  });
});

describe('end-to-end streaming over HTTP', () => {
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
    await fetch(`${base}/${BUCKET}`, { method: 'PUT', headers: auth() });
  }, 30_000);

  afterAll(async () => {
    await closeAllPools();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await sftp.stop();
  }, 15_000);

  function auth(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/20260310/us-east-1/s3/aws4_request, Signature=x`,
      'x-amz-security-token': PASSWORD,
      ...extra,
    };
  }

  it('stores the decoded payload for an aws-chunked upload', async () => {
    const payload = Buffer.from('chunked upload body '.repeat(400));
    const framed = awsChunkFrame(payload, 2048);

    const put = await fetch(`${base}/${BUCKET}/chunked.txt`, {
      method: 'PUT',
      headers: auth({
        'Content-Encoding': 'aws-chunked',
        'x-amz-content-sha256': 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD',
        'x-amz-decoded-content-length': String(payload.length),
      }),
      body: framed,
    });
    expect(put.status).toBe(200);
    // ETag must describe the real object, not the framed transport bytes.
    expect(put.headers.get('etag')).toBe(`"${createHash('md5').update(payload).digest('hex')}"`);

    const get = await fetch(`${base}/${BUCKET}/chunked.txt`, { headers: auth() });
    const body = Buffer.from(await get.arrayBuffer());
    expect(body.equals(payload)).toBe(true);
    expect(get.headers.get('content-length')).toBe(String(payload.length));
  });

  it('reports plaintext Content-Length for an encrypted object', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const payload = Buffer.from('encrypted streaming payload '.repeat(100));

    const put = await fetch(`${base}/${BUCKET}/enc-stream.bin`, {
      method: 'PUT',
      headers: auth({ 'X-Enc-Public-Key': Buffer.from(publicKey).toString('base64') }),
      body: payload,
    });
    expect(put.status).toBe(200);

    const get = await fetch(`${base}/${BUCKET}/enc-stream.bin`, {
      headers: auth({ 'X-Enc-Private-Key': Buffer.from(privateKey).toString('base64') }),
    });
    expect(get.headers.get('content-length')).toBe(String(payload.length));
    expect(Buffer.from(await get.arrayBuffer()).equals(payload)).toBe(true);
  });

  /**
   * Regression: a failing decrypt used to reject the response pipeline while
   * the backend promise was being awaited, producing an unhandled rejection
   * that terminated the whole process. One bad key must not kill the proxy.
   */
  it('survives a GET with the wrong private key and keeps serving', async () => {
    const a = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const b = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    const payload = Buffer.from('key-mismatch payload '.repeat(50));
    const put = await fetch(`${base}/${BUCKET}/mismatch.bin`, {
      method: 'PUT',
      headers: auth({ 'X-Enc-Public-Key': Buffer.from(a.publicKey).toString('base64') }),
      body: payload,
    });
    expect(put.status).toBe(200);

    // Wrong key: the failure is detected before any byte is written, so the
    // client should get a proper S3 error document rather than a dead socket.
    let status = 0;
    let leaked = false;
    try {
      const bad = await fetch(`${base}/${BUCKET}/mismatch.bin`, {
        headers: auth({ 'X-Enc-Private-Key': Buffer.from(b.privateKey).toString('base64') }),
      });
      status = bad.status;
      leaked = Buffer.from(await bad.arrayBuffer()).equals(payload);
    } catch {
      status = -1; // connection destroyed — acceptable, but less useful
    }
    expect(leaked).toBe(false);
    expect(status).toBeGreaterThanOrEqual(400);

    // The server must still be alive and correct afterwards.
    const good = await fetch(`${base}/${BUCKET}/mismatch.bin`, {
      headers: auth({ 'X-Enc-Private-Key': Buffer.from(a.privateKey).toString('base64') }),
    });
    expect(good.status).toBe(200);
    expect(Buffer.from(await good.arrayBuffer()).equals(payload)).toBe(true);
  });

  /**
   * The point of streaming: a large object must not be held in memory. Under
   * the previous buffered implementation this allocated the whole body twice
   * (request buffer + backend buffer); peak RSS growth tracked object size.
   */
  it('transfers a 192 MB object without buffering it in memory', async () => {
    const SIZE = 192 * 1024 * 1024;
    const CHUNK = Buffer.alloc(1024 * 1024, 0xab);

    global.gc?.();
    const before = process.memoryUsage().rss;
    let peak = before;
    const sample = setInterval(() => {
      const rss = process.memoryUsage().rss;
      if (rss > peak) peak = rss;
    }, 25);

    const body = Readable.from((function* () {
      for (let sent = 0; sent < SIZE; sent += CHUNK.length) yield CHUNK;
    })());

    const put = await fetch(`${base}/${BUCKET}/big.bin`, {
      method: 'PUT',
      headers: auth({ 'Content-Type': 'application/octet-stream' }),
      body: Readable.toWeb(body) as ReadableStream,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    expect(put.status).toBe(200);

    // Drain the download without accumulating it, and verify byte count.
    const get = await fetch(`${base}/${BUCKET}/big.bin`, { headers: auth() });
    let received = 0;
    await pipeline(
      Readable.fromWeb(get.body as never),
      new Writable({ write(c: Buffer, _e, cb) { received += c.length; cb(); } }),
    );
    clearInterval(sample);

    expect(received).toBe(SIZE);

    const growthMb = (peak - before) / (1024 * 1024);
    // Buffering would need ≥192 MB; streaming stays in the tens of MB.
    expect(growthMb).toBeLessThan(96);
  }, 180_000);
});
