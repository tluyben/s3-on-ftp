/**
 * Cross-implementation compatibility with putfile-cloud.
 *
 * The proxy's blobs must be readable by putfile clients and vice versa, so the
 * byte layout is pinned here rather than merely round-tripped against itself:
 *
 *   [4B BE RSA key length][RSA-OAEP(SHA-256) AES key][12B IV][AES-256-GCM ct||16B tag]
 *
 * The reference implementations are putfile-cloud's `src/lib/crypto/encryption.ts`
 * (Node) and `src/lib/sync-core/crypto.ts` (WebCrypto). Both are reproduced here
 * independently — a copy that drifts would fail these tests, which is the point.
 */
import { describe, it, expect } from 'vitest';
import {
  generateKeyPairSync,
  createPublicKey,
  createPrivateKey,
  publicEncrypt,
  privateDecrypt,
  createCipheriv,
  randomBytes,
  constants,
} from 'crypto';
import { encryptData, decryptData } from '../src/utils/encryption.js';

const { publicKey: PUB_PEM, privateKey: PRIV_PEM } = generateKeyPairSync('rsa', {
  modulusLength: 2048, // smaller than putfile's 4096 purely to keep tests fast
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

/** Verbatim port of putfile-cloud's encryptBuffer(). */
function putfileEncryptBuffer(plaintext: Buffer, publicKeyPem: string): Buffer {
  const aesKey = randomBytes(32);
  const iv = randomBytes(12);

  const cipher = createCipheriv('aes-256-gcm', aesKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const rsaKey = publicEncrypt(
    { key: createPublicKey(publicKeyPem), padding: 4 /* OAEP */, oaepHash: 'sha256' },
    aesKey,
  );

  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(rsaKey.length, 0);

  // ciphertext || authTag — WebCrypto AES-GCM expects the tag at the end
  return Buffer.concat([lenBuf, rsaKey, iv, ciphertext, authTag]);
}

/**
 * Port of putfile-cloud's WebCrypto decryptBytes(), which slices
 * ct = blob[4+rsaLen+12 ..] and hands the whole thing (tag included) to AES-GCM.
 */
async function putfileDecryptBytes(encrypted: Buffer, privateKeyPem: string): Promise<Buffer> {
  const rsaLen = encrypted.readUInt32BE(0);
  const wrapped = encrypted.subarray(4, 4 + rsaLen);
  const iv = encrypted.subarray(4 + rsaLen, 4 + rsaLen + 12);
  const ct = encrypted.subarray(4 + rsaLen + 12);

  const rawAes = privateDecrypt(
    { key: createPrivateKey(privateKeyPem), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    wrapped,
  );

  const aesKey = await crypto.subtle.importKey('raw', rawAes, { name: 'AES-GCM' }, false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ct);
  return Buffer.from(plain);
}

describe('putfile-cloud crypto compatibility', () => {
  const pub = createPublicKey(PUB_PEM);
  const priv = createPrivateKey(PRIV_PEM);

  it('our ciphertext decrypts with putfile-cloud WebCrypto decryptBytes()', async () => {
    const plaintext = Buffer.from('shared-format payload — accents: äöü, emoji: 🔐');
    const blob = encryptData(plaintext, pub);
    const recovered = await putfileDecryptBytes(blob, PRIV_PEM);
    expect(recovered.equals(plaintext)).toBe(true);
  });

  it('putfile-cloud encryptBuffer() output decrypts with our decryptData()', () => {
    const plaintext = Buffer.from('written by putfile-cloud, read by the proxy');
    const blob = putfileEncryptBuffer(plaintext, PUB_PEM);
    expect(decryptData(blob, priv).equals(plaintext)).toBe(true);
  });

  it('produces the documented byte layout: tag trails the ciphertext', () => {
    const plaintext = Buffer.from('x'.repeat(100));
    const blob = encryptData(plaintext, pub);

    const rsaLen = blob.readUInt32BE(0);
    expect(rsaLen).toBe(256); // 2048-bit RSA
    // 4 + rsaLen + 12 IV + ciphertext(= plaintext length for GCM) + 16 tag
    expect(blob.length).toBe(4 + rsaLen + 12 + plaintext.length + 16);
  });

  it('both implementations agree on layout for an empty payload', async () => {
    const empty = Buffer.alloc(0);
    const ours = encryptData(empty, pub);
    const theirs = putfileEncryptBuffer(empty, PUB_PEM);
    expect(ours.length).toBe(theirs.length);
    expect((await putfileDecryptBytes(ours, PRIV_PEM)).length).toBe(0);
    expect(decryptData(theirs, priv).length).toBe(0);
  });

  it('round-trips a 1 MB payload across both implementations', async () => {
    const big = randomBytes(1024 * 1024);
    expect((await putfileDecryptBytes(encryptData(big, pub), PRIV_PEM)).equals(big)).toBe(true);
    expect(decryptData(putfileEncryptBuffer(big, PUB_PEM), priv).equals(big)).toBe(true);
  });

  it('rejects a tampered tag (the tag is authenticated, not decorative)', () => {
    const blob = encryptData(Buffer.from('integrity matters'), pub);
    blob[blob.length - 1] ^= 0xff; // flip a bit in the trailing tag
    expect(() => decryptData(blob, priv)).toThrow();
  });
});
