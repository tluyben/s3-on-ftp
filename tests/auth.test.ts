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

  it('throws on missing Credential', () => {
    expect(() => extractAccessKey('AWS4-HMAC-SHA256 SignedHeaders=host')).toThrow();
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
