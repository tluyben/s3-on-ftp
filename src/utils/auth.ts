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
 *
 * Our access keys are URIs (`sftp://user@host:22`) and therefore contain
 * slashes. Real AWS SDKs place the access key in the Credential field
 * verbatim — they do NOT URL-encode it — so the key cannot be matched by
 * "everything up to the first slash". Instead we take the whole Credential
 * value and strip the credential scope, which is always exactly four
 * trailing components: <date>/<region>/<service>/aws4_request.
 *
 * This accepts both the raw form (what AWS SDKs send) and the percent-encoded
 * form (what a hand-rolled client might send).
 */
export function extractAccessKey(authHeader: string): string {
  const match = authHeader.match(/Credential=([^,\s]+)/);
  if (!match) {
    throw new Error('Cannot parse Credential from Authorization header');
  }

  const parts = match[1].split('/');
  if (parts.length < 5 || parts[parts.length - 1] !== 'aws4_request') {
    throw new Error(
      'Malformed Credential: expected <AccessKey>/<date>/<region>/<service>/aws4_request',
    );
  }

  const accessKey = parts.slice(0, -4).join('/');
  if (!accessKey) {
    throw new Error('Credential contains an empty Access Key');
  }

  // A raw URI decodes to itself; a percent-encoded one is restored here.
  // Keys containing a literal '%' are not valid escape sequences — keep them as-is.
  try {
    return decodeURIComponent(accessKey);
  } catch {
    return accessKey;
  }
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
