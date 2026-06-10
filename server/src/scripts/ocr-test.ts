// One-shot OCR tester. Hits the same code path the /api/ocr/pump route uses
// (calls runOcr directly, so no need to spin up the server). Useful for
// validating prompt changes against real photos.
//
// Usage:
//   npm run -w server ocr:test -- --dashboard <path> [--pump <path>]
//   npm run -w server ocr:test -- --pump <path>
//
// Notes:
//   - Requires AZURE_OPENAI_ENDPOINT + AZURE_OPENAI_API_KEY in .env (vision deployment).
//   - No DB writes, no resizing, no server. Files are read raw from disk.
//   - MIME is inferred from extension (.jpg/.jpeg/.png/.webp/.heic/.heif).

import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { runOcr, PROMPT_VERSION } from '../services/azureOpenAI.js';

const EXT_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
};

function loadImage(path: string): { base64: string; mime: string } {
  const ext = extname(path).toLowerCase();
  const mime = EXT_MIME[ext];
  if (!mime) {
    console.error(`Unsupported file extension: ${ext}. Allowed: ${Object.keys(EXT_MIME).join(', ')}`);
    process.exit(1);
  }
  const buf = readFileSync(path);
  return { base64: buf.toString('base64'), mime };
}

function parseArgs(argv: string[]): { pump?: string; dashboard?: string } {
  const out: { pump?: string; dashboard?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--pump') out.pump = argv[++i];
    else if (t === '--dashboard') out.dashboard = argv[++i];
    else if (t === '-h' || t === '--help') {
      console.log('Usage: ocr:test -- --dashboard <path> [--pump <path>]');
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${t}`);
      process.exit(1);
    }
  }
  if (!out.pump && !out.dashboard) {
    console.error('Provide at least --pump <path> or --dashboard <path>.');
    process.exit(1);
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const images: { pump?: { base64: string; mime: string }; dashboard?: { base64: string; mime: string } } = {};
  if (args.pump) {
    const img = loadImage(args.pump);
    console.log(`pump:      ${args.pump}  (${img.mime}, ${Math.round(img.base64.length * 0.75 / 1024)} KB)`);
    images.pump = img;
  }
  if (args.dashboard) {
    const img = loadImage(args.dashboard);
    console.log(`dashboard: ${args.dashboard}  (${img.mime}, ${Math.round(img.base64.length * 0.75 / 1024)} KB)`);
    images.dashboard = img;
  }
  console.log(`prompt:    ${PROMPT_VERSION}`);
  console.log('');

  const t0 = Date.now();
  const result = await runOcr(images);
  const dt = Date.now() - t0;

  console.log(`--- parsed (${dt} ms) ---`);
  console.log('pump     :', JSON.stringify(result.pump, null, 2));
  console.log('dashboard:', JSON.stringify(result.dashboard, null, 2));
  if (result.error) console.log('error    :', result.error);

  console.log('\n--- raw model responses ---');
  if (result.raw_pump_response) {
    console.log('pump raw:\n' + result.raw_pump_response);
  }
  if (result.raw_dashboard_response) {
    console.log('dashboard raw:\n' + result.raw_dashboard_response);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack || e.message : e);
  process.exit(1);
});
