import type { BackendAdapter, BackendCredentials } from '../types/backend.js';
import { FtpAdapter } from './ftp.js';
import { SftpAdapter } from './sftp.js';
import { ScpAdapter } from './scp.js';

export async function getAdapter(creds: BackendCredentials): Promise<BackendAdapter> {
  let adapter: FtpAdapter | SftpAdapter | ScpAdapter;

  switch (creds.scheme) {
    case 'ftp':
      adapter = new FtpAdapter(creds);
      break;
    case 'sftp':
      adapter = new SftpAdapter(creds);
      break;
    case 'scp':
      adapter = new ScpAdapter(creds);
      break;
    default: {
      const _exhaustive: never = creds.scheme;
      throw new Error(`Unsupported backend scheme: ${_exhaustive}`);
    }
  }

  await adapter.connect();
  return adapter;
}
