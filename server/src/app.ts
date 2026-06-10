import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { env, isOcrConfigured, isAuthConfigured, ocrKeyLooksUnresolved, storageMode, corsOrigins } from './env.js';
import { createAuthMiddleware } from './auth.js';
import { vehicles } from './routes/vehicles.js';
import { fuelings } from './routes/fuelings.js';
import { ocr } from './routes/ocr.js';
import { geo } from './routes/geo.js';

/**
 * Builds the Tankstelle Hono application (routes mounted under /api/*).
 *
 * This is the portable entry point: the standalone Node server (index.ts) and
 * the Azure Functions host (nexus) both call this and drive `app.fetch`.
 */
export function createApp(): Hono {
  const app = new Hono();

  app.use('*', logger());
  // Applied only when origins are configured; otherwise the host owns CORS
  // (App Service platform CORS in prod) or it's same-origin local dev.
  if (corsOrigins) {
    app.use(
      '/api/*',
      cors({
        origin: corsOrigins,
        allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
        allowHeaders: ['Authorization', 'Content-Type'],
        maxAge: 3600,
      }),
    );
  }

  app.use('/api/*', createAuthMiddleware());

  app.get('/api/health', (c) =>
    c.json({
      ok: true,
      ocr_configured: isOcrConfigured,
      // True when AZURE_OPENAI_API_KEY still holds an unresolved Key Vault
      // reference literal (e.g. the keyVaultReferenceIdentity lacks access).
      ocr_key_unresolved: ocrKeyLooksUnresolved,
      auth_configured: isAuthConfigured,
      model: env.AZURE_OPENAI_DEPLOYMENT,
      storage: env.isAzuriteDev ? 'azurite' : storageMode,
    }),
  );

  app.route('/api/vehicles', vehicles);
  app.route('/api/fuelings', fuelings);
  app.route('/api/ocr', ocr);
  app.route('/api/geo', geo);

  return app;
}
