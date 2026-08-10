import { describe, it, expect } from 'vitest';
import { extractAccessKey, parseAccessKeyUri } from '../src/utils/auth.js';

describe('extractAccessKey', () => {
  it('extracts plain access key', () => {
    const header =
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20260310/us-east-1/s3/aws4_request, SignedHeaders=host, Signature=abc';
    expect(extractAccessKey(header)).toBe('AKIAIOSFODNN7EXAMPLE');
  });

  it('extracts URL-encoded access key URI', () => {
    const encoded = encodeURIComponent('sftp://user@myserver.com');
    const header = `AWS4-HMAC-SHA256 Credential=${encoded}/20260310/us-east-1/s3/aws4_request, SignedHeaders=host, Signature=abc`;
    const key = extractAccessKey(header);
    expect(key).toBe('sftp://user@myserver.com');
  });

  // Regression: real AWS SDKs put the access key in the Credential field
  // VERBATIM — they do not percent-encode it. A parser that stops at the first
  // slash extracts only "sftp:", which breaks every genuine S3 client.
  it('extracts a RAW (unencoded) access key URI, as AWS SDKs send it', () => {
    const header =
      'AWS4-HMAC-SHA256 Credential=sftp://user@myserver.com/20260310/us-east-1/s3/aws4_request, SignedHeaders=host, Signature=abc';
    expect(extractAccessKey(header)).toBe('sftp://user@myserver.com');
  });

  it('extracts a RAW access key URI that includes a port', () => {
    const header =
      'AWS4-HMAC-SHA256 Credential=sftp://u123456-sub1@u123456-sub1.your-storagebox.de:23/20260810/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-date, Signature=abc';
    expect(extractAccessKey(header)).toBe('sftp://u123456-sub1@u123456-sub1.your-storagebox.de:23');
  });

  it('round-trips a raw access key through parseAccessKeyUri', () => {
    const header =
      'AWS4-HMAC-SHA256 Credential=ftp://admin@10.0.0.5:2121/20260310/eu-central-1/s3/aws4_request, Signature=abc';
    expect(parseAccessKeyUri(extractAccessKey(header))).toMatchObject({
      scheme: 'ftp',
      username: 'admin',
      host: '10.0.0.5',
      port: 2121,
    });
  });

  it('throws on missing Credential', () => {
    expect(() => extractAccessKey('AWS4-HMAC-SHA256 SignedHeaders=host')).toThrow();
  });

  it('throws when the credential scope is malformed', () => {
    expect(() => extractAccessKey('AWS4-HMAC-SHA256 Credential=sftp://user@host/20260310/us-east-1')).toThrow();
  });

  it('throws when the access key portion is empty', () => {
    expect(() => extractAccessKey('AWS4-HMAC-SHA256 Credential=/20260310/us-east-1/s3/aws4_request')).toThrow();
  });
});

describe('parseAccessKeyUri', () => {
  it('parses sftp URI with default port', () => {
    const result = parseAccessKeyUri('sftp://user@myserver.com');
    expect(result).toEqual({
      scheme: 'sftp',
      username: 'user',
      host: 'myserver.com',
      port: 22,
    });
  });

  it('parses ftp URI with custom port', () => {
    const result = parseAccessKeyUri('ftp://admin@192.168.1.1:2121');
    expect(result).toEqual({
      scheme: 'ftp',
      username: 'admin',
      host: '192.168.1.1',
      port: 2121,
    });
  });

  it('parses scp URI with default port', () => {
    const result = parseAccessKeyUri('scp://deploy@buildserver.internal');
    expect(result).toEqual({
      scheme: 'scp',
      username: 'deploy',
      host: 'buildserver.internal',
      port: 22,
    });
  });

  it('throws on unsupported scheme', () => {
    expect(() => parseAccessKeyUri('s3://mybucket')).toThrow();
  });

  it('throws on missing username', () => {
    expect(() => parseAccessKeyUri('sftp://myserver.com')).toThrow();
  });
});
