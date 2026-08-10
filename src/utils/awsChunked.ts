/**
 * Decoder for AWS SigV4 streaming uploads (`Content-Encoding: aws-chunked`).
 *
 * When an S3 client streams a PutObject it may frame the body so each chunk
 * carries its own signature:
 *
 *   <hex-length>;chunk-signature=<hex>\r\n
 *   <length bytes of payload>\r\n
 *   ...
 *   0;chunk-signature=<hex>\r\n
 *   [optional trailer headers]\r\n
 *
 * The framing is transport-level, not part of the object. Streaming the raw
 * body to the backend would silently store the chunk headers inside the file,
 * so a framed body must be decoded back to the payload as it passes through.
 *
 * Signatures are not verified — this proxy does not verify SigV4 at all (see
 * README) — but the framing must still be stripped.
 */
import { Transform } from 'stream';
import type { IncomingHttpHeaders } from 'http';

const CRLF = Buffer.from('\r\n');
/** Guards against a malformed stream making us buffer without bound. */
const MAX_CHUNK_HEADER_LEN = 1024;

/** True when the request body is aws-chunked framed. */
export function isAwsChunked(headers: IncomingHttpHeaders): boolean {
  const encoding = String(headers['content-encoding'] ?? '').toLowerCase();
  const sha = String(headers['x-amz-content-sha256'] ?? '').toUpperCase();
  return encoding.includes('aws-chunked') || sha.startsWith('STREAMING-');
}

/**
 * The real object size for an aws-chunked upload, which clients advertise
 * separately because Content-Length covers the framing too.
 */
export function decodedContentLength(headers: IncomingHttpHeaders): number | undefined {
  const raw = headers['x-amz-decoded-content-length'];
  if (raw === undefined) return undefined;
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export function createAwsChunkedDecoder(): Transform {
  let buf: Buffer = Buffer.alloc(0);
  let remaining = 0;         // payload bytes still to copy for the current chunk
  let finished = false;      // saw the terminating zero-length chunk
  let expectCrlf = false;    // payload consumed; expecting the trailing CRLF

  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);

      try {
        for (;;) {
          if (remaining > 0) {
            if (buf.length === 0) break;
            const take = Math.min(remaining, buf.length);
            this.push(buf.subarray(0, take));
            buf = buf.subarray(take);
            remaining -= take;
            if (remaining === 0) expectCrlf = true;
            continue;
          }

          if (expectCrlf) {
            if (buf.length < 2) break;
            // Tolerate servers/clients that omit the CRLF after the payload.
            if (buf.subarray(0, 2).equals(CRLF)) buf = buf.subarray(2);
            expectCrlf = false;
            continue;
          }

          if (finished) {
            buf = Buffer.alloc(0); // trailers — not part of the object
            break;
          }

          const eol = buf.indexOf(CRLF);
          if (eol === -1) {
            if (buf.length > MAX_CHUNK_HEADER_LEN) {
              throw new Error('Malformed aws-chunked stream: chunk header too long');
            }
            break;
          }

          const header = buf.subarray(0, eol).toString('latin1');
          buf = buf.subarray(eol + 2);

          const sizeHex = header.split(';', 1)[0].trim();
          const size = parseInt(sizeHex, 16);
          if (!Number.isFinite(size) || size < 0 || sizeHex === '') {
            throw new Error(`Malformed aws-chunked stream: bad chunk size "${sizeHex}"`);
          }

          if (size === 0) {
            finished = true; // trailers may follow; ignore them
            continue;
          }
          remaining = size;
        }
        cb();
      } catch (err) {
        cb(err as Error);
      }
    },

    flush(cb) {
      // A well-formed aws-chunked body always ends with a zero-length chunk.
      // Without these checks a connection dropped mid-upload would be stored as
      // a silently truncated object.
      if (remaining > 0) {
        cb(new Error('Malformed aws-chunked stream: truncated chunk payload'));
        return;
      }
      if (!finished) {
        cb(new Error('Malformed aws-chunked stream: missing terminating chunk'));
        return;
      }
      cb();
    },
  });
}
