import { Router, type Request, type Response } from 'express';
import { createHash } from 'crypto';
import { Transform, type Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { parseCredentials } from '../middleware/parseCredentials.js';
import { acquireConnection } from '../utils/connectionPool.js';
import type { BackendAdapter, BackendCredentials } from '../types/backend.js';
import {
  buildListBucketsXml,
  buildListObjectsXml,
  buildListObjectsV2Xml,
  buildErrorXml,
} from '../utils/xml.js';
import {
  getEncryptionConfig,
  keyFromHeader,
  createEncryptStream,
  createDecryptStream,
  encryptionOverhead,
} from '../utils/encryption.js';
import { isAwsChunked, createAwsChunkedDecoder } from '../utils/awsChunked.js';

const router = Router();

// Apply credential parsing to all S3 routes
router.use(parseCredentials);

// ── Helpers ────────────────────────────────────────────────────────────────

function requireCreds(res: Response): BackendCredentials | null {
  if (!res.locals.backendCreds) {
    res
      .status(403)
      .type('application/xml')
      .send(buildErrorXml('AccessDenied', 'Missing or invalid Authorization header'));
    return null;
  }
  return res.locals.backendCreds as BackendCredentials;
}

/**
 * Map a backend (FTP/SFTP) failure onto an S3 error response.
 *
 * Backends report "not found" with server-specific wording — SFTPGo says
 * "file does not exist", proftpd says "No such file or directory", vsftpd says
 * "Failed to open file" — so message matching alone is unreliable. FTP reply
 * codes (RFC 959) and ssh2's symbolic codes are checked first; text matching is
 * only the fallback.
 *
 * `targetsKey` decides whether a missing path is reported as NoSuchKey (object
 * operations) or NoSuchBucket (bucket-level operations).
 */
function sendBackendError(res: Response, err: unknown, targetsKey: boolean): void {
  const msg = err instanceof Error ? err.message : String(err);
  const rawCode = (err as { code?: string | number }).code;
  const ftpCode = typeof rawCode === 'number' ? rawCode : undefined;

  const notFound =
    rawCode === 'NoSuchKey' ||
    rawCode === 'NoSuchBucket' ||
    rawCode === 'ENOENT' ||
    ftpCode === 550 || // "Requested action not taken: file unavailable"
    /nosuchkey|no such file|does not exist|not found|enoent/i.test(msg);

  const denied =
    rawCode === 'EACCES' ||
    ftpCode === 530 || // "Not logged in"
    /permission denied|authentication|credential|password|eacces|\bauth\b/i.test(msg);

  if (notFound) {
    const code = targetsKey ? 'NoSuchKey' : 'NoSuchBucket';
    const text = targetsKey
      ? 'The specified key does not exist.'
      : 'The specified bucket does not exist.';
    res.status(404).type('application/xml').send(buildErrorXml(code, text));
  } else if (denied) {
    res.status(403).type('application/xml').send(buildErrorXml('AccessDenied', msg));
  } else {
    console.error('[s3-proxy] backend error:', err);
    res.status(500).type('application/xml').send(buildErrorXml('InternalError', msg));
  }
}

/**
 * Await every promise, then surface the first failure.
 *
 * Streaming work runs as two concurrent promises (feed the chain / drain into
 * the backend). `Promise.all` rejects on the first failure and leaves the other
 * promise's later rejection unhandled — which terminates the process. Every
 * promise must therefore be settled before the error is rethrown.
 */
/**
 * Pipe `source` into the response, surfacing errors instead of tearing the
 * socket down on its own.
 *
 * `pipeline()` destroys the response the instant the source errors, which turns
 * a recoverable early failure (e.g. a wrong decryption key, detected before a
 * single byte is written) into an aborted connection. Using pipe() and
 * rejecting instead lets the caller decide: a clean S3 error document if
 * nothing has been sent yet, or an aborted transfer if it has.
 */
function pipeToResponse(source: Readable, res: Response): Promise<void> {
  return new Promise((resolve, reject) => {
    const fail = (err: Error): void => {
      source.destroy();
      reject(err);
    };
    source.once('error', fail);
    res.once('finish', resolve);
    res.once('error', fail);
    res.once('close', () => {
      if (!res.writableFinished) fail(new Error('Client closed the connection'));
    });
    source.pipe(res);
  });
}

async function settleAll(promises: Array<Promise<unknown>>): Promise<void> {
  const results = await Promise.allSettled(promises);
  const failed = results.find(r => r.status === 'rejected');
  if (failed) throw (failed as PromiseRejectedResult).reason;
}

async function withAdapter(
  res: Response,
  bucket: string,
  fn: (adapter: BackendAdapter) => Promise<void>,
  targetsKey = false,
): Promise<void> {
  const reqCreds = requireCreds(res);
  if (!reqCreds) return;

  const creds: BackendCredentials = { ...reqCreds, bucket };
  let release: (() => void) | null = null;
  try {
    const handle = await acquireConnection(creds);
    release = handle.release;
    await fn(handle.adapter);
  } catch (err) {
    if (res.headersSent) {
      // Streaming had already begun, so no error document can be sent. Abort
      // the connection instead of ending cleanly — a truncated body must not
      // look like a complete object to the client.
      console.error('[s3-proxy] backend error mid-stream:', err);
      res.destroy(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    sendBackendError(res, err, targetsKey);
  } finally {
    release?.();
  }
}

// ── Routes ─────────────────────────────────────────────────────────────────

/**
 * GET / — ListBuckets
 * Returns empty list: no bucket registry exists in the proxy.
 */
router.get('/', (_req: Request, res: Response) => {
  res.type('application/xml').send(buildListBucketsXml([]));
});

/**
 * HEAD /:bucket — HeadBucket
 */
router.head('/:bucket', (req: Request, res: Response) => {
  void withAdapter(res, req.params.bucket, async adapter => {
    const exists = await adapter.bucketExists();
    if (!exists) {
      res.status(404).type('application/xml').send(buildErrorXml('NoSuchBucket', 'Bucket does not exist'));
    } else {
      res.status(200).end();
    }
  });
});

/**
 * PUT /:bucket — CreateBucket
 */
router.put('/:bucket', (req: Request, res: Response) => {
  void withAdapter(res, req.params.bucket, async adapter => {
    if (await adapter.bucketExists()) {
      res.status(409).type('application/xml')
        .send(buildErrorXml('BucketAlreadyOwnedByYou', 'The bucket already exists and is owned by you.'));
      return;
    }
    await adapter.createBucket();
    res.status(200).set('Location', `/${req.params.bucket}`).end();
  });
});

/**
 * GET /:bucket — ListObjects / ListObjectsV2
 */
router.get('/:bucket', (req: Request, res: Response) => {
  void withAdapter(res, req.params.bucket, async adapter => {
    const prefix = typeof req.query.prefix === 'string' ? req.query.prefix : '';
    const entries = await adapter.listObjects(prefix);
    const listType = req.query['list-type'];
    const xml = listType === '2'
      ? buildListObjectsV2Xml(req.params.bucket, prefix, entries)
      : buildListObjectsXml(req.params.bucket, prefix, entries);
    res.type('application/xml').send(xml);
  });
});

/**
 * HEAD /:bucket/:key — HeadObject
 */
router.head('/:bucket/*', (req: Request, res: Response) => {
  const key = (req.params as Record<string, string>)['0'] ?? '';
  void withAdapter(res, req.params.bucket, async adapter => {
    const meta = await adapter.headObject(key);
    res.set({
      'Content-Length': String(meta.size),
      'Last-Modified': meta.lastModified.toUTCString(),
      'ETag': `"${meta.etag}"`,
      'Content-Type': 'application/octet-stream',
    }).status(200).end();
  }, true);
});

/**
 * GET /:bucket/:key — GetObject
 */
router.get('/:bucket/*', (req: Request, res: Response) => {
  const key = (req.params as Record<string, string>)['0'] ?? '';
  void withAdapter(res, req.params.bucket, async adapter => {
    const headerVal = req.get('X-Enc-Private-Key');
    const privKey = headerVal ? keyFromHeader(headerVal, 'private') : getEncryptionConfig().privateKey;

    // stat first: headers must be complete before the first body byte streams.
    const meta = await adapter.headObject(key);
    const size = privKey ? meta.size - encryptionOverhead(privKey) : meta.size;

    res.set({
      // ETag matches HeadObject/ListObjects; the plaintext MD5 is unknowable
      // without buffering the whole object, which is exactly what we avoid.
      'ETag': `"${meta.etag}"`,
      'Last-Modified': meta.lastModified.toUTCString(),
      'Content-Type': 'application/octet-stream',
      ...(size >= 0 ? { 'Content-Length': String(size) } : {}),
    }).status(200);

    if (!privKey) {
      await adapter.downloadTo(key, res);
      return;
    }

    // backend → decrypt → client, all streamed; nothing lands in memory.
    const decryptor = createDecryptStream(privKey);
    await settleAll([
      pipeToResponse(decryptor, res),
      adapter.downloadTo(key, decryptor),
    ]);
  }, true);
});

/**
 * PUT /:bucket/:key — PutObject
 */
router.put('/:bucket/*', (req: Request, res: Response) => {
  const key = (req.params as Record<string, string>)['0'] ?? '';
  void withAdapter(res, req.params.bucket, async adapter => {
    const headerVal = req.get('X-Enc-Public-Key');
    const pubKey = headerVal ? keyFromHeader(headerVal, 'public') : getEncryptionConfig().publicKey;

    // The request body is never buffered. It flows through an optional
    // aws-chunked decoder, an MD5 tap, and optional encryption, straight into
    // the backend — upload size is bounded by the socket, not by RAM.
    const stages: Transform[] = [];
    if (isAwsChunked(req.headers)) stages.push(createAwsChunkedDecoder());

    // The ETag must describe the plaintext, so hash before encrypting.
    //
    // This must be a Transform, NOT a PassThrough with a 'data' listener: a
    // 'data' handler switches the stream to flowing mode immediately, so any
    // bytes arriving before the backend attaches (uploadFrom awaits mkdirp for
    // nested keys) would be discarded. A Transform keeps backpressure and only
    // yields data to an actual consumer.
    const md5 = createHash('md5');
    stages.push(new Transform({
      transform(chunk: Buffer, _enc, cb) {
        md5.update(chunk);
        cb(null, chunk);
      },
    }));

    if (pubKey) stages.push(createEncryptStream(pubKey));

    // `tail` carries the bytes the backend should store. Running the transform
    // chain and the backend write concurrently keeps a single pass over the
    // data; pipeline() tears the whole chain down if any stage fails.
    const tail = stages[stages.length - 1];
    await settleAll([
      pipeline([req, ...stages]),
      adapter.uploadFrom(key, tail),
    ]);

    res.set('ETag', `"${md5.digest('hex')}"`).status(200).end();
  }, true);
});

/**
 * DELETE /:bucket/:key — DeleteObject
 */
router.delete('/:bucket/*', (req: Request, res: Response) => {
  const key = (req.params as Record<string, string>)['0'] ?? '';
  void withAdapter(res, req.params.bucket, async adapter => {
    await adapter.deleteObject(key);
    res.status(204).end();
  }, true);
});

export default router;
