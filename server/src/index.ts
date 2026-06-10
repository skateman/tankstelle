import { serve } from '@hono/node-server';
import { env, isOcrConfigured } from './env.js';
import { createApp } from './app.js';

const app = createApp();

if (env.HOST !== '127.0.0.1' && env.HOST !== 'localhost') {
  console.warn(
    `[tankstelle] WARNING: binding to ${env.HOST} exposes this no-auth API beyond localhost. ` +
      `Anyone on the network can read/write fuelings and call Azure OpenAI through /api/ocr.`,
  );
}
if (!isOcrConfigured) {
  console.warn(
    '[tankstelle] WARNING: AZURE_OPENAI_ENDPOINT / AZURE_OPENAI_API_KEY not set. OCR will return null results.',
  );
}

serve({ fetch: app.fetch, hostname: env.HOST, port: env.PORT }, (info) => {
  console.log(`[tankstelle] listening on http://${env.HOST}:${info.port}`);
});
