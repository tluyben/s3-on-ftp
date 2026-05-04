import type { BackendScheme } from '../types/backend.js';

export interface ParsedAccessKey {
  scheme: BackendScheme;
  username: string;
  host: string;
  port: number;
  maxConnections?: number;
}

/**
 * Extract the Access Key ID from an AWS Signature V4 Authorization header.
 *
 * Header format:
 *   AWS4-HMAC-SHA256 Credential=<AccessKey>/<date>/<region>/<service>/aws4_request,
 *                   SignedHeaders=..., Signature=...
 */
export function extractAccessKey(authHeader: string): string {
  const match = authHeader.match(/Credential=([^/\s,]+)/);
  if (!match) {
    throw new Error('Cannot parse Credential from Authorization header');
  }
  return decodeURIComponent(match[1]);
}

/**
 * Parse an access key URI like `sftp://user@host:22` or `ftp://user@host`.
 *
 * Special characters in the URI (://@) are URL-encoded by AWS SDKs when
 * signing — we decode them first.
 */
export function parseAccessKeyUri(accessKey: string): ParsedAccessKey {
  // Normalise to http:// so URL constructor can parse it
  const schemeMatch = accessKey.match(/^(sftp|scp|ftp):\/\//i);
  if (!schemeMatch) {
    throw new Error(`Access Key must start with ftp://, sftp://, or scp:// — got: ${accessKey}`);
  }
  const scheme = schemeMatch[1].toLowerCase() as BackendScheme;
  const normalised = accessKey.replace(/^(sftp|scp|ftp):\/\//i, 'http://');

  let parsed: URL;
  try {
    parsed = new URL(normalised);
  } catch {
    throw new Error(`Invalid Access Key URI: ${accessKey}`);
  }

  const defaultPort = scheme === 'ftp' ? 21 : 22;
  const port = parsed.port ? parseInt(parsed.port, 10) : defaultPort;
  const username = decodeURIComponent(parsed.username);

  if (!username) {
    throw new Error(`Access Key URI must include a username: ${accessKey}`);
  }
  if (!parsed.hostname) {
    throw new Error(`Access Key URI must include a hostname: ${accessKey}`);
  }

  const maxConnectionsParam = parsed.searchParams.get('maxConnections');
  const maxConnections = maxConnectionsParam !== null ? parseInt(maxConnectionsParam, 10) : undefined;

  return { scheme, username, host: parsed.hostname, port, maxConnections };
}
