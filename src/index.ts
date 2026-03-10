import express from 'express';
import cors from 'cors';
import { readPort } from './utils/port.js';
import s3Router from './routes/s3.js';

const app = express();
const PORT = readPort();

// CORS
app.use(cors());

// Raw body for object uploads — must precede json middleware
// Handles PUT /:bucket/:key (PutObject)
app.use((req, res, next) => {
  if (req.method === 'PUT' && req.path.split('/').length > 2) {
    express.raw({ type: '*/*', limit: '5gb' })(req, res, next);
  } else {
    next();
  }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check
app.get('/health', (_req, res) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    service: 's3-protocol-proxy',
  });
});

// S3-compatible API
app.use('/', s3Router);

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`S3 Protocol Proxy listening on http://0.0.0.0:${PORT}`);
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
