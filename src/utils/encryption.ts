/**
 * Hybrid encryption: RSA public key wraps a per-object AES-256-GCM key.
 *
 * Wire format (all fields concatenated):
 *   [4 bytes]  big-endian uint32 — length of the RSA-encrypted AES key
 *   [N bytes]  RSA-OAEP(SHA-256) encrypted AES-256 key (N = RSA key size)
 *   [12 bytes] AES-GCM nonce / IV
 *   [rest]     AES-256-GCM ciphertext, with the 16-byte auth tag APPENDED
 *
 * This layout is byte-compatible with putfile-cloud
 * (`src/lib/crypto/encryption.ts` and `src/lib/sync-core/crypto.ts`), so blobs
 * written here decrypt with any putfile client and vice versa. The tag must
 * trail the ciphertext because WebCrypto's AES-GCM expects it there — it will
 * not accept a tag carried in a separate field.
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
import { Transform } from 'stream';
import {
  publicEncrypt,
  privateDecrypt,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  constants,
  type KeyObject,
  type DecipherGCM,
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
  const encryptedKey = publicEncrypt(
    { key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    aesKey,
  );

  const keyLenBuf = Buffer.alloc(4);
  keyLenBuf.writeUInt32BE(encryptedKey.length, 0);

  // Encrypt plaintext with AES-256-GCM
  const cipher = createCipheriv('aes-256-gcm', aesKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag(); // 16 bytes

  // Tag trails the ciphertext — WebCrypto AES-GCM requires that ordering.
  return Buffer.concat([keyLenBuf, encryptedKey, iv, ciphertext, tag]);
}

const GCM_TAG_LEN = 16;
const IV_LEN = 12;

/** Byte overhead the container adds on top of the plaintext, for a given key. */
export function encryptionOverhead(key: KeyObject): number {
  const modulusLength = key.asymmetricKeyDetails?.modulusLength;
  if (!modulusLength) throw new Error('Not an RSA key — cannot determine ciphertext length');
  return 4 + modulusLength / 8 + IV_LEN + GCM_TAG_LEN;
}

/**
 * Streaming encryption. Emits the header ([length][wrapped key][IV]) ahead of
 * the first ciphertext byte and appends the auth tag on flush — the tag-last
 * layout exists precisely so the container can be produced in one pass without
 * ever holding the object in memory.
 */
export function createEncryptStream(keyOverride?: KeyObject): Transform {
  const key = keyOverride ?? getEncryptionConfig().publicKey;
  if (!key) throw new Error('No public key available — set PUBLIC_KEY env var or send X-Enc-Public-Key header');

  const aesKey = randomBytes(32);
  const iv = randomBytes(IV_LEN);
  const encryptedKey = publicEncrypt(
    { key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    aesKey,
  );
  const keyLenBuf = Buffer.alloc(4);
  keyLenBuf.writeUInt32BE(encryptedKey.length, 0);

  const cipher = createCipheriv('aes-256-gcm', aesKey, iv);
  let headerWritten = false;

  const writeHeader = (stream: Transform): void => {
    if (headerWritten) return;
    headerWritten = true;
    stream.push(Buffer.concat([keyLenBuf, encryptedKey, iv]));
  };

  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      try {
        writeHeader(this);
        cb(null, cipher.update(chunk));
      } catch (err) {
        cb(err as Error);
      }
    },
    flush(cb) {
      try {
        writeHeader(this); // zero-length objects still get a valid container
        this.push(cipher.final());
        this.push(cipher.getAuthTag());
        cb();
      } catch (err) {
        cb(err as Error);
      }
    },
  });
}

/**
 * Streaming decryption. Parses the header incrementally, then decrypts while
 * withholding the trailing 16 bytes (the auth tag), which are only available
 * once the stream ends.
 *
 * SECURITY: because GCM's tag trails the ciphertext, plaintext is emitted
 * before it can be authenticated. A tampered object therefore surfaces as a
 * stream error *after* some bytes have already been delivered — the transfer
 * fails and the response is destroyed, but a client that consumes data
 * incrementally must treat a failed transfer as untrusted and discard it. This
 * is inherent to streaming AEAD; the alternative is buffering whole objects.
 */
export function createDecryptStream(keyOverride?: KeyObject): Transform {
  const key = keyOverride ?? getEncryptionConfig().privateKey;
  if (!key) throw new Error('No private key available — set PRIVATE_KEY env var or send X-Enc-Private-Key header');

  let header: Buffer = Buffer.alloc(0);
  let decipher: DecipherGCM | null = null;
  let held: Buffer = Buffer.alloc(0); // trailing bytes that might be the auth tag

  /** Consume body bytes, emitting all but the final 16. */
  function consume(stream: Transform, chunk: Buffer): void {
    held = held.length === 0 ? chunk : Buffer.concat([held, chunk]);
    if (held.length <= GCM_TAG_LEN) return;
    const releasable = held.subarray(0, held.length - GCM_TAG_LEN);
    held = held.subarray(held.length - GCM_TAG_LEN);
    const plain = decipher!.update(releasable);
    if (plain.length > 0) stream.push(plain);
  }

  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      try {
        if (decipher) {
          consume(this, chunk);
          return cb();
        }

        header = Buffer.concat([header, chunk]);
        if (header.length < 4) return cb();

        const keyLen = header.readUInt32BE(0);
        const headerLen = 4 + keyLen + IV_LEN;
        if (header.length < headerLen) return cb();

        const encryptedKey = header.subarray(4, 4 + keyLen);
        const iv = header.subarray(4 + keyLen, headerLen);
        const aesKey = privateDecrypt(
          { key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
          encryptedKey,
        );
        decipher = createDecipheriv('aes-256-gcm', aesKey, iv);

        const rest = header.subarray(headerLen);
        header = Buffer.alloc(0);
        if (rest.length > 0) consume(this, rest);
        cb();
      } catch (err) {
        cb(err as Error);
      }
    },
    flush(cb) {
      try {
        if (!decipher) return cb(new Error('Encrypted object is truncated: incomplete header'));
        if (held.length !== GCM_TAG_LEN) {
          return cb(new Error('Ciphertext is truncated: missing AES-GCM authentication tag'));
        }
        decipher.setAuthTag(held);
        this.push(decipher.final()); // throws if the object was tampered with
        cb();
      } catch (err) {
        cb(err as Error);
      }
    },
  });
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

  // Remainder is ciphertext||tag — the tag is the final 16 bytes.
  const body = data.subarray(offset);
  if (body.length < GCM_TAG_LEN) {
    throw new Error('Ciphertext is truncated: missing AES-GCM authentication tag');
  }
  const ciphertext = body.subarray(0, body.length - GCM_TAG_LEN);
  const tag = body.subarray(body.length - GCM_TAG_LEN);

  // Unwrap AES key
  const aesKey = privateDecrypt(
    { key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    encryptedKey,
  );

  // Decrypt with AES-256-GCM (tag is verified automatically; throws on tamper)
  const decipher = createDecipheriv('aes-256-gcm', aesKey, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
