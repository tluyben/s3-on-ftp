/**
 * Hybrid encryption: RSA public key wraps a per-object AES-256-GCM key.
 *
 * Wire format (all fields concatenated):
 *   [4 bytes]  big-endian uint32 — length of the RSA-encrypted AES key
 *   [N bytes]  RSA-encrypted AES-256 key (N = key length in bytes)
 *   [12 bytes] AES-GCM nonce / IV
 *   [16 bytes] AES-GCM authentication tag
 *   [rest]     AES-256-GCM ciphertext
 *
 * Key resolution order (first wins):
 *   1. keyOverride argument passed directly to encryptData / decryptData
 *   2. PUBLIC_KEY / PRIVATE_KEY environment variables (file paths)
 *
 * Per-request key injection via HTTP headers:
 *   X-Enc-Public-Key: <base64-encoded PEM>   →  encrypt on PUT
 *   X-Enc-Private-Key: <base64-encoded PEM>  →  decrypt on GET
 *
 * AWS S3 silently ignores headers it does not recognise, so sending these
 * headers to real S3 is a no-op and does not break anything.
 */

import { readFileSync } from 'fs';
import {
  publicEncrypt,
  privateDecrypt,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  type KeyObject,
  createPublicKey,
  createPrivateKey,
} from 'crypto';

interface EncryptionConfig {
  publicKey: KeyObject | null;
  privateKey: KeyObject | null;
}

let cachedConfig: EncryptionConfig | null = null;

/** Reset the key cache — for testing only. */
export function _resetCache(): void {
  cachedConfig = null;
}

export function getEncryptionConfig(): EncryptionConfig {
  if (cachedConfig) return cachedConfig;

  const pubPath = process.env.PUBLIC_KEY;
  const privPath = process.env.PRIVATE_KEY;

  cachedConfig = {
    publicKey: pubPath ? createPublicKey(readFileSync(pubPath)) : null,
    privateKey: privPath ? createPrivateKey(readFileSync(privPath)) : null,
  };

  return cachedConfig;
}

export function isEncryptionEnabled(): boolean {
  return !!(process.env.PUBLIC_KEY || process.env.PRIVATE_KEY);
}

/**
 * Parse a key from the value of X-Enc-Public-Key / X-Enc-Private-Key.
 * The header value must be the PEM string base64-encoded (so it is a
 * single-line, header-safe ASCII string).
 */
export function keyFromHeader(b64pem: string, type: 'public' | 'private'): KeyObject {
  const pem = Buffer.from(b64pem, 'base64').toString('utf8');
  return type === 'public' ? createPublicKey(pem) : createPrivateKey(pem);
}

/**
 * Encrypt a buffer with RSA-OAEP + AES-256-GCM.
 * Pass keyOverride to use a per-request key (from the X-Enc-Public-Key header);
 * otherwise falls back to the PUBLIC_KEY env-var key.
 */
export function encryptData(plaintext: Buffer, keyOverride?: KeyObject): Buffer {
  const key = keyOverride ?? getEncryptionConfig().publicKey;
  if (!key) throw new Error('No public key available — set PUBLIC_KEY env var or send X-Enc-Public-Key header');

  const aesKey = randomBytes(32); // AES-256
  const iv = randomBytes(12);     // GCM standard nonce

  // Wrap the AES key with RSA-OAEP
  const encryptedKey = publicEncrypt({ key, oaepHash: 'sha256' }, aesKey);

  const keyLenBuf = Buffer.alloc(4);
  keyLenBuf.writeUInt32BE(encryptedKey.length, 0);

  // Encrypt plaintext with AES-256-GCM
  const cipher = createCipheriv('aes-256-gcm', aesKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag(); // 16 bytes

  return Buffer.concat([keyLenBuf, encryptedKey, iv, tag, ciphertext]);
}

/**
 * Decrypt a buffer produced by encryptData.
 * Pass keyOverride to use a per-request key (from the X-Enc-Private-Key header);
 * otherwise falls back to the PRIVATE_KEY env-var key.
 */
export function decryptData(data: Buffer, keyOverride?: KeyObject): Buffer {
  const key = keyOverride ?? getEncryptionConfig().privateKey;
  if (!key) throw new Error('No private key available — set PRIVATE_KEY env var or send X-Enc-Private-Key header');

  let offset = 0;

  const keyLen = data.readUInt32BE(offset);
  offset += 4;

  const encryptedKey = data.subarray(offset, offset + keyLen);
  offset += keyLen;

  const iv = data.subarray(offset, offset + 12);
  offset += 12;

  const tag = data.subarray(offset, offset + 16);
  offset += 16;

  const ciphertext = data.subarray(offset);

  // Unwrap AES key
  const aesKey = privateDecrypt({ key, oaepHash: 'sha256' }, encryptedKey);

  // Decrypt with AES-256-GCM (tag is verified automatically; throws on tamper)
  const decipher = createDecipheriv('aes-256-gcm', aesKey, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
