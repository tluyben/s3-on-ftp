import { Router, type Request, type Response } from 'express';
import { createHash } from 'crypto';
import { parseCredentials } from '../middleware/parseCredentials.js';
import { getAdapter } from '../adapters/factory.js';
import type { BackendAdapter, BackendCredentials } from '../types/backend.js';
import {
  buildListBucketsXml,
  buildListObjectsXml,
  buildListObjectsV2Xml,
  buildErrorXml,
} from '../utils/xml.js';
import { getEncryptionConfig, encryptData, decryptData, keyFromHeader } from '../utils/encryption.js';

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

async function withAdapter(
  res: Response,
  bucket: string,
  fn: (adapter: BackendAdapter) => Promise<void>,
): Promise<void> {
  const baseCreds = requireCreds(res);
  if (!baseCreds) return;

  const creds: BackendCredentials = { ...baseCreds, bucket };
  let adapter: BackendAdapter | null = null;
  try {
    adapter = await getAdapter(creds);
    await fn(adapter);
  } catch (err) {
    if (res.headersSent) return;
    const msg = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: string }).code;

    if (code === 'NoSuchKey' || msg.includes('NoSuchKey')) {
      res.status(404).type('application/xml').send(buildErrorXml('NoSuchKey', 'The specified key does not exist.'));
    } else if (code === 'NoSuchBucket' || msg.includes('No such file')) {
      res.status(404).type('application/xml').send(buildErrorXml('NoSuchBucket', 'The specified bucket does not exist.'));
    } else if (msg.includes('ENOENT')) {
      res.status(404).type('application/xml').send(buildErrorXml('NoSuchKey', msg));
    } else if (msg.includes('AUTH') || msg.includes('auth') || msg.includes('password') || msg.includes('credentials')) {
      res.status(403).type('application/xml').send(buildErrorXml('AccessDenied', msg));
    } else {
      console.error('[s3-proxy] backend error:', err);
      res.status(500).type('application/xml').send(buildErrorXml('InternalError', msg));
    }
  } finally {
    if (adapter) {
      await adapter.disconnect().catch(() => { /* ignore disconnect errors */ });
    }
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
  });
});

/**
 * GET /:bucket/:key — GetObject
 */
router.get('/:bucket/*', (req: Request, res: Response) => {
  const key = (req.params as Record<string, string>)['0'] ?? '';
  void withAdapter(res, req.params.bucket, async adapter => {
    const raw = await adapter.getObject(key);
    const headerVal = req.get('X-Enc-Private-Key');
    const privKey = headerVal ? keyFromHeader(headerVal, 'private') : getEncryptionConfig().privateKey;
    const data = privKey ? decryptData(raw, privKey) : raw;
    res.set({
      'Content-Length': String(data.length),
      'Content-Type': 'application/octet-stream',
      'ETag': `"${createHash('md5').update(data).digest('hex')}"`,
    }).send(data);
  });
});

/**
 * PUT /:bucket/:key — PutObject
 */
router.put('/:bucket/*', (req: Request, res: Response) => {
  const key = (req.params as Record<string, string>)['0'] ?? '';
  void withAdapter(res, req.params.bucket, async adapter => {
    const body = req.body as Buffer;
    const headerVal = req.get('X-Enc-Public-Key');
    const pubKey = headerVal ? keyFromHeader(headerVal, 'public') : getEncryptionConfig().publicKey;
    const dataToStore = pubKey ? encryptData(body, pubKey) : body;
    await adapter.putObject(key, dataToStore);
    // ETag is always of the original plaintext so clients can verify content
    const etag = createHash('md5').update(body).digest('hex');
    res.set('ETag', `"${etag}"`).status(200).end();
  });
});

/**
 * DELETE /:bucket/:key — DeleteObject
 */
router.delete('/:bucket/*', (req: Request, res: Response) => {
  const key = (req.params as Record<string, string>)['0'] ?? '';
  void withAdapter(res, req.params.bucket, async adapter => {
    await adapter.deleteObject(key);
    res.status(204).end();
  });
});

export default router;
