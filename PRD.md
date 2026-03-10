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
- Recursive directory listing
- Object streaming (buffered in RAM for simplicity)

## Technical Stack

- TypeScript + Express.js
- `basic-ftp` for FTP client
- `ssh2` for SFTP/SCP client and test server
- `xmlbuilder2` for S3 XML responses
- `vitest` for tests
- `ftp-srv` for FTP test server

## Testing

Integration tests start real local FTP and SFTP servers, perform all CRUD operations, and stop the servers. No external services required.

## Port

Read from `./.port` file at startup (Docker-compatible).
