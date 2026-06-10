import { Hono } from 'hono';
import { createOcrAttempt } from '../db/ocrAttempts.js';
import { runOcr, PROMPT_VERSION } from '../services/azureOpenAI.js';

export const ocr = new Hono();

const MAX_BYTES = 8 * 1024 * 1024; // 8 MB per image
const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);

async function fileToImage(f: File | null) {
  if (!f) return undefined;
  if (f.size === 0) return undefined;
  if (f.size > MAX_BYTES) {
    throw new Error(`Image too large: ${f.size} bytes (max ${MAX_BYTES}).`);
  }
  const mime = f.type || 'image/jpeg';
  if (!ALLOWED_MIME.has(mime)) {
    throw new Error(`Unsupported image MIME: ${mime}.`);
  }
  const buf = Buffer.from(await f.arrayBuffer());
  return { base64: buf.toString('base64'), mime };
}

ocr.post('/pump', async (c) => {
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: 'expected_multipart_form_data' }, 400);
  }

  let pumpImg, dashImg;
  try {
    pumpImg = await fileToImage(form.get('pump') as File | null);
    dashImg = await fileToImage(form.get('dashboard') as File | null);
  } catch (e) {
    return c.json({ error: 'invalid_image', message: (e as Error).message }, 400);
  }

  if (!pumpImg && !dashImg) {
    return c.json({ error: 'no_images', message: 'Provide pump and/or dashboard image.' }, 400);
  }

  const result = await runOcr({ pump: pumpImg, dashboard: dashImg });

  // Best-effort audit write: the OCR result is already computed (and billed), so
  // a transient Table Storage failure here must not sink the response.
  try {
    await createOcrAttempt({
      fueling_id: null,
      pump_image_present: Boolean(pumpImg),
      dashboard_image_present: Boolean(dashImg),
      model: result.model,
      prompt_version: PROMPT_VERSION,
      parsed_json: JSON.stringify({ pump: result.pump, dashboard: result.dashboard }),
      raw_pump_response: result.raw_pump_response ?? null,
      raw_dashboard_response: result.raw_dashboard_response ?? null,
      error: result.error ?? null,
    });
  } catch (e) {
    console.warn('[ocr] audit write failed (non-fatal):', (e as Error).message);
  }

  return c.json({
    pump: result.pump,
    pump_cross_check: result.pump_cross_check,
    dashboard: result.dashboard,
    model: result.model,
    prompt_version: PROMPT_VERSION,
    raw_pump_response: result.raw_pump_response ?? null,
    raw_dashboard_response: result.raw_dashboard_response ?? null,
    error: result.error ?? null,
  });
});
