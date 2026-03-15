# S3 Protocol Proxy

A local S3-compatible API server that transparently proxies S3 requests to **FTP**, **SFTP**, and **SCP** backends. Use any standard S3 client (AWS CLI, AWS SDK, Nextcloud, etc.) with your existing FTP/SFTP servers — no code changes needed.

## How It Works

The proxy receives S3 API requests and translates them to the appropriate backend protocol. Connection details are encoded directly in the S3 credentials:

| S3 Field       | Maps To                                          |
|----------------|--------------------------------------------------|
| Endpoint URL   | `http://localhost:<port>` (this proxy)           |
| Access Key     | Backend URI: `sftp://username@myserver.com`      |
| Secret Key     | Any value (signature not verified)               |
| Session Token  | Backend password                                 |
| Bucket Name    | Remote directory name                            |
| Region         | Ignored                                          |

## Quick Start

```bash
npm install
npm run dev
```

The server starts on the port specified in `./.port` (defaults to `3000`).

## Supported Protocols

| Protocol | Example Access Key              | Default Port |
|----------|---------------------------------|--------------|
| SFTP     | `sftp://user@myserver.com`     | 22           |
| SCP      | `scp://user@myserver.com`      | 22           |
| FTP      | `ftp://user@ftp.example.com`   | 21           |

Custom ports: `sftp://user@myserver.com:2222`

## Usage Examples

### AWS CLI

```bash
export AWS_ACCESS_KEY_ID="sftp://user@myserver.com"
export AWS_SECRET_ACCESS_KEY="ignored"
export AWS_SESSION_TOKEN="your-ssh-password"
export AWS_DEFAULT_REGION="us-east-1"

# List files in remote directory "backups"
aws s3 ls s3://backups/ --endpoint-url http://localhost:3001

# Upload a file
aws s3 cp myfile.tar.gz s3://backups/myfile.tar.gz --endpoint-url http://localhost:3001

# Download a file
aws s3 cp s3://backups/myfile.tar.gz ./restore.tar.gz --endpoint-url http://localhost:3001
```

### AWS SDK (Node.js)

```javascript
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';

const s3 = new S3Client({
  endpoint: 'http://localhost:3001',
  region: 'us-east-1',
  credentials: {
    accessKeyId: 'sftp://user@myserver.com',
    secretAccessKey: 'ignored',
    sessionToken: 'your-ssh-password',  // backend password
  },
  forcePathStyle: true,
});
```

### ~/.aws/credentials

```ini
[s3proxy]
aws_access_key_id     = sftp://user@myserver.com
aws_secret_access_key = ignored
aws_session_token     = your-ssh-password
region                = us-east-1
```

```bash
aws --profile s3proxy --endpoint-url http://localhost:3001 s3 ls s3://backups/
```

## S3 API Operations Supported

| Operation     | HTTP Method | Path               |
|---------------|-------------|--------------------|
| ListBuckets   | GET         | `/`                |
| HeadBucket    | HEAD        | `/:bucket`         |
| CreateBucket  | PUT         | `/:bucket`         |
| ListObjects   | GET         | `/:bucket`         |
| GetObject     | GET         | `/:bucket/:key`    |
| PutObject     | PUT         | `/:bucket/:key`    |
| DeleteObject  | DELETE      | `/:bucket/:key`    |
| HeadObject    | HEAD        | `/:bucket/:key`    |

## API Endpoints

- `GET /health` — Health check
- `GET /` — S3 ListBuckets
- `GET /:bucket` — S3 ListObjects
- `PUT /:bucket` — S3 CreateBucket
- `HEAD /:bucket` — S3 HeadBucket
- `GET /:bucket/:key` — S3 GetObject
- `PUT /:bucket/:key` — S3 PutObject
- `DELETE /:bucket/:key` — S3 DeleteObject
- `HEAD /:bucket/:key` — S3 HeadObject

## Transparent At-Rest Encryption

The proxy can encrypt objects before writing them to the backend and decrypt them on read-back. Encryption is **hybrid RSA + AES-256-GCM**: a fresh AES-256 key is generated per object, encrypted with your RSA public key, and stored alongside the ciphertext. The private key is only needed for reads.

### Key resolution order (first wins per request)

| Priority | Source | Header / Env var |
|----------|--------|-----------------|
| 1 | Per-request HTTP header | `X-Enc-Public-Key` / `X-Enc-Private-Key` |
| 2 | Server-side env var | `PUBLIC_KEY` / `PRIVATE_KEY` |

**Both sources are independently optional.** If no key is found for a request the data is passed through unmodified.

### Option A — server-side env vars (applies to every request)

```bash
PUBLIC_KEY=/path/to/pub.pem  PRIVATE_KEY=/path/to/priv.pem  npm run dev
```

### Option B — per-request headers (keys travel with the client)

Pass the PEM file **base64-encoded** in the request headers. AWS S3 silently ignores unknown headers, so these headers are a no-op when the same client talks to real S3.

```bash
# Encode your keys once
PUB_B64=$(base64 -w0 /path/to/pub.pem)
PRIV_B64=$(base64 -w0 /path/to/priv.pem)

# Upload — proxy encrypts before writing to FTP/SFTP
aws s3 cp secret.tar.gz s3://backups/secret.tar.gz \
  --endpoint-url http://localhost:3001 \
  --no-verify-ssl \
  -- \
  # aws CLI does not support arbitrary headers natively;
  # use the SDK or a thin wrapper (see below)
```

With the **AWS SDK (Node.js)**:

```javascript
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { readFileSync } from 'fs';

const PUB_B64  = Buffer.from(readFileSync('/path/to/pub.pem')).toString('base64');
const PRIV_B64 = Buffer.from(readFileSync('/path/to/priv.pem')).toString('base64');

const s3 = new S3Client({
  endpoint: 'http://localhost:3001',
  region: 'us-east-1',
  credentials: { accessKeyId: 'sftp://user@myserver.com', secretAccessKey: 'x', sessionToken: 'pw' },
  forcePathStyle: true,
});

// PUT — proxy encrypts the data before storing
await s3.send(new PutObjectCommand({
  Bucket: 'backups',
  Key: 'secret.tar.gz',
  Body: fileBuffer,
  // custom headers via the SDK's requestParameters
}), {
  requestHandler: { metadata: { customHeaders: { 'x-enc-public-key': PUB_B64 } } },
});

// GET — proxy decrypts transparently
await s3.send(new GetObjectCommand({ Bucket: 'backups', Key: 'secret.tar.gz' }), {
  requestHandler: { metadata: { customHeaders: { 'x-enc-private-key': PRIV_B64 } } },
});
```

> **Header format:** base64-encode the raw PEM text (including `-----BEGIN ...-----` lines).
> `base64 -w0 pub.pem` on Linux / `base64 pub.pem` on macOS.

### Generating a key pair

```bash
# 4096-bit RSA (recommended for long-lived keys)
openssl genrsa -out priv.pem 4096
openssl rsa -in priv.pem -pubout -out pub.pem
```

### Notes

- The ETag returned to the client is always the MD5 of the **original plaintext**, so client-side integrity checks continue to work.
- Objects stored while encryption was disabled are returned as-is (no decryption attempted unless a key is supplied).
- `HeadObject` reports the size of the **stored** (encrypted) object; this may differ from the plaintext size.

## Why Session Token for Password?

The S3 Secret Key is used only to compute an HMAC signature — it is **never transmitted** in the HTTP request. The session token field (`X-Amz-Security-Token`) is a standard S3 field that carries extra credential data. Real S3 servers ignore unknown session tokens, so configuring `aws_session_token = yourpassword` is backward-compatible with any S3 endpoint.

## Development Scripts

- `npm run dev` — Start development server with hot reload
- `npm run build` — Compile TypeScript
- `npm run start` — Run compiled server
- `npm run check` — TypeScript type checking
- `npm run test` — Run all tests (starts/stops local FTP + SFTP servers)

## Project Structure

```
src/
├── index.ts              # Main server
├── types/backend.ts      # BackendCredentials, FileEntry, BackendAdapter
├── utils/
│   ├── port.ts           # Read port from ./.port file
│   ├── auth.ts           # Parse AWS Authorization header
│   ├── xml.ts            # S3 XML response builders
│   ├── errors.ts         # S3 error codes
│   └── encryption.ts     # Hybrid RSA+AES-256-GCM encrypt/decrypt
├── adapters/
│   ├── base.ts           # Abstract BaseAdapter
│   ├── ftp.ts            # FTP adapter (basic-ftp)
│   ├── sftp.ts           # SFTP adapter (ssh2)
│   ├── scp.ts            # SCP adapter (ssh2)
│   └── factory.ts        # Create adapter from credentials
├── middleware/
│   └── parseCredentials.ts  # Extract backend URI from auth header
└── routes/s3.ts          # S3 API route handlers

tests/
├── helpers/
│   ├── ftpServer.ts      # Local FTP test server (ftp-srv)
│   └── sftpServer.ts     # Local SFTP test server (ssh2)
├── auth.test.ts          # Auth header parsing unit tests
├── encryption.test.ts    # Encryption utility unit tests
├── ftp.test.ts           # FTP adapter integration tests
└── sftp.test.ts          # SFTP adapter integration tests
```

## Limitations

- No signature verification (trust-based, for local use)
- Objects buffered in RAM (no streaming for very large files)
- No multipart upload
- No ACLs, versioning, or lifecycle policies
- Flat directory listing only
- Rsync: future extension (requires CLI wrapper)
