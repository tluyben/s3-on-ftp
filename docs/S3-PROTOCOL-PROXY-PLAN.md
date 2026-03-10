# S3 Protocol Proxy — Plan

## What We Are Building

A local S3-compatible API server that acts as a transparent proxy between any standard S3 client (AWS CLI, SDKs, Nextcloud, etc.) and backend file transfer protocols: **FTP**, **SFTP**, and **SCP**.

The user configures their S3 client exactly as they would for real S3 — no code changes needed. The only difference is how credentials are entered:

| S3 Field      | Value in this proxy                              |
|---------------|--------------------------------------------------|
| Endpoint URL  | `http://localhost:<port>` (this server)          |
| Access Key    | Backend URI: `sftp://username@myserver.com`      |
| Secret Key    | Password on the remote server                    |
| Bucket Name   | Remote directory name                            |
| Region        | Ignored                                          |

### Example S3 Client Configuration

```
Endpoint:   http://localhost:3001
Access Key: sftp://backupuser@myserver.com
Secret Key: mysecretpassword
Bucket:     backups
Region:     us-east-1   (ignored)
```

This translates to: connect to `myserver.com` via SFTP as `backupuser` with password `mysecretpassword`, and use the remote directory `backups`.

---

## How It Works

```
S3 Client (AWS CLI / SDK / Nextcloud / ...)
     │
     │  HTTP  (S3 API: GET/PUT/DELETE/HEAD + AWS4 Auth header)
     ▼
Local S3 Proxy  (Express.js on localhost:PORT)
     │
     │  Parse Authorization header → extract Access Key
     │  Access Key = sftp://username@host  → parse scheme, user, host
     │  Secret Key = password (via X-Amz-Security-Token header)
     │  Bucket = remote directory
     │
     ├─ ftp://   → FTP adapter  (basic-ftp)
     ├─ sftp://  → SFTP adapter (ssh2)
     └─ scp://   → SCP adapter  (ssh2, SFTP subsystem)
```

### Why X-Amz-Security-Token for the Password?

The S3 secret key is used to compute an HMAC signature — it is **never transmitted** in the Authorization header. We repurpose the session token field (`X-Amz-Security-Token`) to carry the backend password. AWS SDKs support setting a session token, and real S3 servers simply ignore unknown session tokens. This means:

- AWS CLI: set `aws_session_token = mypassword` in `~/.aws/credentials`
- AWS SDK: set `sessionToken: 'mypassword'` in the credentials object
- Nextcloud / other apps: set the "Session Token" field to the password

---

## Functional Requirements

### S3 API Operations Supported

| Operation     | HTTP Method | Path                  | Description                   |
|---------------|-------------|-----------------------|-------------------------------|
| ListBuckets   | GET         | `/`                   | Returns empty list (no registry) |
| HeadBucket    | HEAD        | `/:bucket`            | Check if remote dir exists    |
| CreateBucket  | PUT         | `/:bucket`            | Create remote directory       |
| ListObjects   | GET         | `/:bucket`            | List files in remote dir      |
| GetObject     | GET         | `/:bucket/:key`       | Download file                 |
| PutObject     | PUT         | `/:bucket/:key`       | Upload file                   |
| DeleteObject  | DELETE      | `/:bucket/:key`       | Delete file                   |
| HeadObject    | HEAD        | `/:bucket/:key`       | File metadata                 |

### Supported Protocols

| Protocol | Library   | Default Port | Notes                             |
|----------|-----------|--------------|-----------------------------------|
| FTP      | basic-ftp | 21           | Standard FTP                      |
| SFTP     | ssh2      | 22           | SSH File Transfer Protocol        |
| SCP      | ssh2      | 22           | Uses SFTP subsystem via SSH2      |

### Limitations (Known Scope Constraints)

- No signature verification (the HMAC is parsed but not validated)
- Object size limited to available RAM (streaming not implemented)
- No multipart upload (S3 multipart is out of scope)
- No ACLs, versioning, or lifecycle policies
- Rsync support: future extension (requires CLI wrapper)
- Directory listings are flat (no recursive listing / common prefixes)

---

## Technical Architecture

### File Structure

```
src/
├── index.ts                    # Main server: reads .port, mounts router
├── types/
│   ├── backend.ts              # BackendCredentials, FileEntry, BackendAdapter
│   └── s3.ts                   # S3 request/response types
├── utils/
│   ├── port.ts                 # readPort() helper
│   ├── auth.ts                 # parseAuthorizationHeader(), parseAccessKeyToUri()
│   ├── xml.ts                  # xmlbuilder2 helpers for S3 XML responses
│   └── errors.ts               # S3 error XML factories
├── adapters/
│   ├── base.ts                 # BaseAdapter abstract class
│   ├── ftp.ts                  # FtpAdapter (basic-ftp)
│   ├── sftp.ts                 # SftpAdapter (ssh2)
│   ├── scp.ts                  # ScpAdapter (ssh2, same as SFTP)
│   └── factory.ts              # getAdapter(creds) → BackendAdapter
├── middleware/
│   └── parseCredentials.ts     # Express middleware: parse auth header
└── routes/
    └── s3.ts                   # All S3 route handlers

tests/
├── helpers/
│   ├── ftpServer.ts            # Start/stop local FTP test server (ftp-srv)
│   └── sftpServer.ts           # Start/stop local SFTP test server (ssh2)
├── auth.test.ts                # Unit tests for auth header parsing
├── ftp.test.ts                 # FTP adapter integration tests
└── sftp.test.ts                # SFTP adapter integration tests
```

### Key Design Decisions

1. **Access Key as Backend URI** — encodes all backend connection info (protocol, user, host, port) in one field. Zero config required in the proxy itself.

2. **Password via Session Token** — the S3 secret is never transmitted; session token is the established mechanism for passing extra credentials without signature changes.

3. **Per-request connection lifecycle** — each S3 request opens a fresh backend connection, performs the operation, then disconnects. Simpler than connection pooling for a local proxy.

4. **Path-style S3 URLs** — simpler Express routing, no subdomain handling needed. Works natively with `--endpoint-url` in AWS CLI.

5. **XML responses with xmlbuilder2** — correct namespace, encoding, and escaping for S3-compatible XML.

---

## Testing Strategy

Tests start real local servers, run all CRUD operations via the adapters, then stop the servers. Port 0 is used (OS-assigned) to avoid conflicts.

- `tests/helpers/sftpServer.ts` — `ssh2` in server mode with in-memory virtual FS backed by OS temp dir
- `tests/helpers/ftpServer.ts` — `ftp-srv` with OS temp dir as root
- Integration tests cover: putObject, getObject, listObjects, headObject, deleteObject, bucketExists, createBucket

---

## Usage Examples

### AWS CLI

```bash
# Configure
export AWS_ACCESS_KEY_ID="sftp://user@myserver.com"
export AWS_SECRET_ACCESS_KEY="any_value_signature_not_checked"
export AWS_SESSION_TOKEN="mypassword"
export AWS_DEFAULT_REGION="us-east-1"

# List files in remote dir "backups"
aws s3 ls s3://backups/ --endpoint-url http://localhost:3001 --no-verify-ssl

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
    sessionToken: 'mypassword',  // ← backend password goes here
  },
  forcePathStyle: true,
});

const result = await s3.send(new ListObjectsV2Command({ Bucket: 'backups' }));
```

---

## Implementation Notes

- `ftp-srv` v4 requires `esModuleInterop: true` (already in tsconfig)
- `ssh2` SFTP server requires implementing the full SFTP subsystem (OPEN, READ, WRITE, CLOSE, OPENDIR, READDIR, STAT, MKDIR, REMOVE) — use OS temp dir as backing store
- Access Key URI special characters (`://`, `@`) must be URL-encoded when AWS SDK signs the request; the proxy decodes them with `decodeURIComponent`
- TypeScript strict mode enabled; all `any` types avoided
