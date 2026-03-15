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
 * Keys are loaded once at first call and cached for the process lifetime.
 * Set PUBLIC_KEY=/path/to/pub.pem  → encryption enabled on PUT
 * Set PRIVATE_KEY=/path/to/priv.pem → decryption enabled on GET
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

/** Encrypt a buffer using the configured public key. Throws if PUBLIC_KEY is not set. */
export function encryptData(plaintext: Buffer): Buffer {
  const { publicKey } = getEncryptionConfig();
  if (!publicKey) throw new Error('PUBLIC_KEY env var is not set — cannot encrypt');

  const aesKey = randomBytes(32); // AES-256
  const iv = randomBytes(12);     // GCM standard nonce

  // Wrap the AES key with RSA-OAEP
  const encryptedKey = publicEncrypt({ key: publicKey, oaepHash: 'sha256' }, aesKey);

  const keyLenBuf = Buffer.alloc(4);
  keyLenBuf.writeUInt32BE(encryptedKey.length, 0);

  // Encrypt plaintext with AES-256-GCM
  const cipher = createCipheriv('aes-256-gcm', aesKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag(); // 16 bytes

  return Buffer.concat([keyLenBuf, encryptedKey, iv, tag, ciphertext]);
}

/** Decrypt a buffer using the configured private key. Throws if PRIVATE_KEY is not set. */
export function decryptData(data: Buffer): Buffer {
  const { privateKey } = getEncryptionConfig();
  if (!privateKey) throw new Error('PRIVATE_KEY env var is not set — cannot decrypt');

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
  const aesKey = privateDecrypt({ key: privateKey, oaepHash: 'sha256' }, encryptedKey);

  // Decrypt with AES-256-GCM (tag is verified automatically; throws on tamper)
  const decipher = createDecipheriv('aes-256-gcm', aesKey, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
