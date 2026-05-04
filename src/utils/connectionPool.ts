import type { BackendCredentials } from '../types/backend.js';
import { FtpAdapter } from '../adapters/ftp.js';
import { SftpAdapter } from '../adapters/sftp.js';
import { ScpAdapter } from '../adapters/scp.js';
import type { BaseAdapter } from '../adapters/base.js';

const DEFAULT_MAX_CONNECTIONS = 10;
const FTP_KEEPALIVE_MS = 60_000;
const ACQUIRE_TIMEOUT_MS = 30_000;

interface PoolEntry {
  adapter: BaseAdapter;
  busy: boolean;
}

interface ServerPool {
  entries: PoolEntry[];
  maxSize: number;
  waiters: Array<(entry: PoolEntry) => void>;
}

type BaseCreds = Omit<BackendCredentials, 'bucket'>;

const pools = new Map<string, ServerPool>();
const baseCreds = new Map<string, BaseCreds>();

function poolKey(creds: BackendCredentials): string {
  return `${creds.scheme}:${creds.username}@${creds.host}:${creds.port}:${creds.password}`;
}

function makeAdapter(creds: BackendCredentials): BaseAdapter {
  switch (creds.scheme) {
    case 'ftp':  return new FtpAdapter(creds);
    case 'sftp': return new SftpAdapter(creds);
    case 'scp':  return new ScpAdapter(creds);
    default: {
      const exhaustive: never = creds.scheme;
      throw new Error(`Unsupported scheme: ${String(exhaustive)}`);
    }
  }
}

function isAlive(adapter: BaseAdapter): boolean {
  if (adapter instanceof FtpAdapter)  return !adapter.isClosed();
  if (adapter instanceof SftpAdapter) return adapter.isConnected();
  return true;
}

function startFtpKeepalive(pool: ServerPool): void {
  const timer = setInterval(() => {
    for (const entry of pool.entries) {
      if (!entry.busy && entry.adapter instanceof FtpAdapter) {
        void entry.adapter.keepAlive().catch(() => {
          // Dead connection will be reconnected on next acquire
        });
      }
    }
  }, FTP_KEEPALIVE_MS);
  timer.unref();
}

function getOrCreatePool(creds: BackendCredentials): ServerPool {
  const key = poolKey(creds);
  if (!pools.has(key)) {
    const pool: ServerPool = {
      entries: [],
      maxSize: creds.maxConnections ?? DEFAULT_MAX_CONNECTIONS,
      waiters: [],
    };
    pools.set(key, pool);
    baseCreds.set(key, {
      scheme: creds.scheme,
      username: creds.username,
      host: creds.host,
      port: creds.port,
      password: creds.password,
      maxConnections: creds.maxConnections,
    });
    if (creds.scheme === 'ftp') startFtpKeepalive(pool);
  }
  return pools.get(key)!;
}

function makeHandle(pool: ServerPool, entry: PoolEntry): { adapter: BaseAdapter; release: () => void } {
  let released = false;
  return {
    adapter: entry.adapter,
    release() {
      if (released) return;
      released = true;
      if (pool.waiters.length > 0) {
        const waiter = pool.waiters.shift()!;
        waiter(entry); // entry stays busy; waiter takes ownership
      } else {
        entry.busy = false;
      }
    },
  };
}

export async function acquireConnection(creds: BackendCredentials): Promise<{ adapter: BaseAdapter; release: () => void }> {
  const key = poolKey(creds);
  const pool = getOrCreatePool(creds);

  // Try to reuse an idle connection
  for (const entry of [...pool.entries]) {
    if (entry.busy) continue;
    entry.busy = true; // reserve before any await to prevent concurrent grabs

    if (!isAlive(entry.adapter)) {
      try {
        await entry.adapter.connect();
      } catch {
        pool.entries.splice(pool.entries.indexOf(entry), 1);
        continue;
      }
    }

    entry.adapter.useBucket(creds.bucket);
    return makeHandle(pool, entry);
  }

  // Grow the pool if under the limit
  if (pool.entries.length < pool.maxSize) {
    const base = baseCreds.get(key)!;
    const adapter = makeAdapter({ ...base, bucket: creds.bucket });
    await adapter.connect();
    const entry: PoolEntry = { adapter, busy: true };
    pool.entries.push(entry);
    return makeHandle(pool, entry);
  }

  // All connections busy — wait for one to free up
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      const idx = pool.waiters.indexOf(onFree);
      if (idx !== -1) pool.waiters.splice(idx, 1);
      reject(new Error('Connection pool timed out waiting for a free connection'));
    }, ACQUIRE_TIMEOUT_MS);

    const onFree = (entry: PoolEntry) => {
      clearTimeout(timeout);
      entry.adapter.useBucket(creds.bucket);
      resolve(makeHandle(pool, entry));
    };

    pool.waiters.push(onFree);
  });
}
