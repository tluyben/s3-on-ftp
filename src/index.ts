import { readPort } from './utils/port.js';
import { isEncryptionEnabled, getEncryptionConfig } from './utils/encryption.js';
import { createApp } from './app.js';

const app = createApp();
const PORT = readPort();

// Last-resort guard. Request handling settles its own streaming promises, but a
// proxy must not die because one transfer failed in an unforeseen way — Node's
// default action for an unhandled rejection is to terminate the process.
process.on('unhandledRejection', reason => {
  console.error('[s3-proxy] unhandled rejection (request aborted, server continuing):', reason);
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`S3 Protocol Proxy listening on http://0.0.0.0:${PORT}`);
  if (isEncryptionEnabled()) {
    const { publicKey, privateKey } = getEncryptionConfig();
    console.log('');
    console.log('Encryption:');
    console.log(`  Encrypt on PUT : ${publicKey ? `yes (${process.env.PUBLIC_KEY})` : 'no (PUBLIC_KEY not set)'}`);
    console.log(`  Decrypt on GET : ${privateKey ? `yes (${process.env.PRIVATE_KEY})` : 'no (PRIVATE_KEY not set)'}`);
  }
  console.log('');
  console.log('Configure your S3 client:');
  console.log(`  Endpoint URL : http://localhost:${PORT}`);
  console.log('  Access Key   : sftp://username@myserver.com');
  console.log('  Secret Key   : (any value)');
  console.log('  Session Token: your-backend-password');
  console.log('  Bucket       : remote-directory-name');
  console.log('  Region       : us-east-1 (ignored)');
});

export default app;
