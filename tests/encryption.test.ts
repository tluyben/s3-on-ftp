import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import { writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { encryptData, decryptData, getEncryptionConfig, _resetCache } from '../src/utils/encryption.js';

// Generate a fresh RSA key pair once for the whole test run
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pubPath = join(tmpdir(), 'test_s3proxy_pub.pem');
const privPath = join(tmpdir(), 'test_s3proxy_priv.pem');
writeFileSync(pubPath, publicKey.export({ type: 'pkcs1', format: 'pem' }));
writeFileSync(privPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));

describe('encryption utility', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.PUBLIC_KEY = process.env.PUBLIC_KEY;
    savedEnv.PRIVATE_KEY = process.env.PRIVATE_KEY;
    process.env.PUBLIC_KEY = pubPath;
    process.env.PRIVATE_KEY = privPath;
    _resetCache();
  });

  afterEach(() => {
    if (savedEnv.PUBLIC_KEY === undefined) delete process.env.PUBLIC_KEY;
    else process.env.PUBLIC_KEY = savedEnv.PUBLIC_KEY;
    if (savedEnv.PRIVATE_KEY === undefined) delete process.env.PRIVATE_KEY;
    else process.env.PRIVATE_KEY = savedEnv.PRIVATE_KEY;
    _resetCache();
  });

  it('round-trips plaintext through encrypt → decrypt', () => {
    const original = Buffer.from('Hello, encrypted S3 proxy!');
    const recovered = decryptData(encryptData(original));
    expect(recovered.toString()).toBe(original.toString());
  });

  it('ciphertext differs from plaintext', () => {
    const original = Buffer.from('sensitive data');
    expect(encryptData(original).equals(original)).toBe(false);
  });

  it('produces different ciphertext each call (random IV + key)', () => {
    const original = Buffer.from('same input');
    expect(encryptData(original).equals(encryptData(original))).toBe(false);
  });

  it('handles large buffers (1 MB)', () => {
    const original = Buffer.alloc(1024 * 1024, 0xab);
    expect(decryptData(encryptData(original)).equals(original)).toBe(true);
  });

  it('handles empty buffer', () => {
    const original = Buffer.alloc(0);
    expect(decryptData(encryptData(original)).length).toBe(0);
  });

  it('throws when decrypting tampered ciphertext (GCM auth failure)', () => {
    const ct = encryptData(Buffer.from('tamper me'));
    ct[ct.length - 1] ^= 0xff; // flip last byte of AES-GCM ciphertext
    expect(() => decryptData(ct)).toThrow();
  });

  it('throws on encrypt when PUBLIC_KEY is not set', () => {
    delete process.env.PUBLIC_KEY;
    _resetCache();
    expect(() => encryptData(Buffer.from('x'))).toThrow(/PUBLIC_KEY/);
  });

  it('throws on decrypt when PRIVATE_KEY is not set', () => {
    const ct = encryptData(Buffer.from('x'));
    delete process.env.PRIVATE_KEY;
    _resetCache();
    expect(() => decryptData(ct)).toThrow(/PRIVATE_KEY/);
  });

  it('getEncryptionConfig returns keys when env vars are set', () => {
    const config = getEncryptionConfig();
    expect(config.publicKey).not.toBeNull();
    expect(config.privateKey).not.toBeNull();
  });

  it('getEncryptionConfig returns nulls when env vars are absent', () => {
    delete process.env.PUBLIC_KEY;
    delete process.env.PRIVATE_KEY;
    _resetCache();
    const config = getEncryptionConfig();
    expect(config.publicKey).toBeNull();
    expect(config.privateKey).toBeNull();
  });
});
