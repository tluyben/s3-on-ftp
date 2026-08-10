import express, { type Request } from 'express';
import cors from 'cors';
import s3Router from './routes/s3.js';

/** PUT /:bucket/:key — the only route whose body is an object payload. */
function isObjectUpload(req: Request): boolean {
  return req.method === 'PUT' && req.path.split('/').filter(Boolean).length > 1;
}

/**
 * Builds the Express app without binding a port, so tests can mount it on an
 * ephemeral port and exercise the real HTTP layer (middleware included).
 * `src/index.ts` owns the actual listen().
 */
export function createApp(): express.Express {
  const app = express();

  // CORS
  app.use(cors());

  // Object uploads (PUT /:bucket/:key) are streamed straight to the backend, so
  // NO body parser may touch them — a parser would buffer the whole object in
  // memory and defeat the point. Every other route gets the usual parsers.
  const jsonParser = express.json();
  const urlencodedParser = express.urlencoded({ extended: true });

  app.use((req, res, next) => {
    if (isObjectUpload(req)) {
      next(); // leave req untouched and unread — the route pipes it
      return;
    }
    jsonParser(req, res, err => (err ? next(err) : urlencodedParser(req, res, next)));
  });

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

  return app;
}
