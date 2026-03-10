import type { Request, Response, NextFunction } from 'express';
import { extractAccessKey, parseAccessKeyUri } from '../utils/auth.js';
import { buildErrorXml } from '../utils/xml.js';
import type { BackendCredentials } from '../types/backend.js';

declare module 'express-serve-static-core' {
  interface Locals {
    backendCreds?: BackendCredentials;
  }
}

/**
 * Parses AWS4 Authorization header and X-Amz-Security-Token (used as backend password).
 * Attaches BackendCredentials (without bucket) to res.locals.backendCreds.
 *
 * The bucket is set separately by route handlers from req.params.bucket.
 */
export function parseCredentials(req: Request, res: Response, next: NextFunction): void {
  const auth = req.headers['authorization'];

  if (!auth || !auth.startsWith('AWS4-HMAC-SHA256')) {
    // Allow unauthenticated access to /health
    next();
    return;
  }

  try {
    const accessKey = extractAccessKey(auth);
    const uriParts = parseAccessKeyUri(accessKey);

    // The backend password comes from the session token field.
    // S3 Secret Key is never transmitted — it's used only for the HMAC signature.
    // Clients must set aws_session_token (or sessionToken) to the backend password.
    const password = (req.headers['x-amz-security-token'] as string | undefined) ?? '';

    res.locals.backendCreds = {
      ...uriParts,
      password,
      bucket: '', // filled in by route handlers
    };

    next();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res
      .status(403)
      .type('application/xml')
      .send(buildErrorXml('InvalidClientTokenId', msg));
  }
}
