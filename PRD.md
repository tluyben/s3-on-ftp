# PRD: S3 Protocol Proxy

## Overview

A local S3-compatible API proxy that translates standard Amazon S3 API calls into FTP, SFTP, and SCP backend operations. Enables existing S3-based backup and storage tools to use legacy file transfer protocols without any code changes.

## Problem Statement

Many backup tools, cloud apps (Nextcloud, Duplicati, etc.), and storage libraries support S3 as a storage backend. However, organizations often have existing file servers accessible only via FTP, SFTP, or SCP. Bridging these protocols typically requires custom code changes or dedicated tools.

## Solution

A zero-configuration S3 proxy that:
1. Runs locally and presents a standard S3 HTTP API
2. Maps S3 credentials to backend connection details via a URI convention in the Access Key
3. Performs the requested S3 operations transparently using the appropriate protocol

## Credential Convention

The backend connection is encoded entirely in standard S3 credential fields:

- **Access Key** = `<protocol>://<username>@<host>[:<port>]`  
  Examples: `sftp://backup@myserver.com`, `ftp://user@ftp.example.com:2121`
- **Session Token** = backend password
- **Bucket** = remote directory name
- **Region** = ignored

The S3 Secret Key is not transmitted (used for HMAC only), so signature verification is intentionally skipped.

**Wire-format note:** AWS SDKs place the Access Key into the SigV4
`Credential=` field verbatim — they do **not** percent-encode it. Because our
access keys are URIs containing `/`, the parser must strip the trailing
credential scope (`<date>/<region>/<service>/aws4_request`) rather than reading
up to the first slash. Both raw and percent-encoded forms are accepted.

## Supported Protocols

| Protocol | Notes                              |
|----------|------------------------------------|
| SFTP     | SSH File Transfer Protocol         |
| SCP      | Uses SSH2 SFTP subsystem           |
| FTP      | Standard File Transfer Protocol    |
| Rsync    | Future: CLI wrapper                |

## S3 API Surface

Minimum viable S3 compatibility for backup use cases:

- ListBuckets (returns empty list)
- CreateBucket / HeadBucket
- ListObjects / ListObjectsV2
- GetObject / PutObject
- DeleteObject / HeadObject

## Non-Goals

- Signature verification (not needed for local trusted proxy)
- Multipart upload
- ACLs, versioning, lifecycle policies
- Listing pagination (`MaxKeys` / `ContinuationToken`) and delimiter support

## Streaming

Object bodies are never buffered. Uploads flow socket → optional `aws-chunked`
decode → MD5 tap → optional encryption → backend; downloads reverse it. Memory
is therefore independent of object size, and transfers begin delivering before
they finish reading.

Consequences that shape the design:

- No body parser may run on `PUT /:bucket/:key`; parsing means buffering.
- `GetObject` stats the object first so `Content-Length` is known before the
  first byte is written.
- Backend connections stay checked out of the pool for the whole transfer, since
  the adapter promise resolves only on completion.
- Streaming AEAD releases plaintext before the trailing auth tag is verified, so
  a corrupt object aborts the response mid-transfer instead of returning an
  error document. Failures detected before the first byte still return one.

## Interoperability with putfile-cloud

Two behaviours are deliberately matched to putfile-cloud so the two systems can
share data:

1. **Encryption format.** Hybrid RSA-OAEP(SHA-256) + AES-256-GCM with the layout
   `[4B key length][wrapped AES key][12B IV][ciphertext||16B tag]`. The auth tag
   trails the ciphertext so WebCrypto can decrypt directly. Verified in both
   directions by `tests/crypto-compat.test.ts`.
2. **Recursive listing.** `ListObjects` walks the whole subtree and returns flat
   slash-separated keys, mirroring putfile-cloud's `listObjectsInDirectory()`.
   Directories are never returned as objects.

## Technical Stack

- TypeScript + Express.js
- `basic-ftp` for FTP client
- `ssh2` for SFTP/SCP client and test server
- `xmlbuilder2` for S3 XML responses
- `vitest` for tests
- `ftp-srv` for FTP test server

## Testing

Integration tests start real local FTP and SFTP servers, perform all CRUD operations, and stop the servers. No external services required.

Coverage is layered:

- **Adapter tests** drive `FtpAdapter` / `SftpAdapter` against the local servers.
- **HTTP tests** (`tests/http.test.ts`) mount the real Express app on an
  ephemeral port and exercise the S3 API over a socket. This layer is where
  client-compatibility defects live — request parsing, body handling, status
  mapping — and adapter tests cannot reach it.

The local SFTP test server deliberately mirrors real-server strictness (it will
not create missing parent directories on write), so that adapter bugs with
nested S3 keys surface in tests rather than in production.

## Port

Read from `./.port` file at startup (Docker-compatible).
