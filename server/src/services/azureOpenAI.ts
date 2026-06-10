import { env, isOcrConfigured } from '../env.js';

export const PROMPT_VERSION = 'v2';

const PUMP_SYSTEM = `You read fuel pump displays. Return STRICT JSON only, no prose, matching exactly:
{
  "liters": number|null,
  "total_price": number|null,
  "price_per_liter": number|null,
  "currency_hint": string|null,
  "fuel_type": "diesel"|"gasoline_95"|"gasoline_98"|"e10"|"premium"|"other"|null,
  "confidence": "high"|"medium"|"low"
}
Rules:
- Never invent values. If a field is not clearly visible, return null for that field.
- Numbers must use a period as decimal separator. No thousands separators.
- currency_hint must be the ISO 4217 code if a symbol or code is visible (EUR, USD, HUF, CHF, etc.), else null.
- Lower confidence when digits are partially obscured or glare reduces certainty.`;

const DASH_SYSTEM = `You read vehicle instrument clusters from a photo. Return STRICT JSON only, no prose, matching exactly:
{
  "odometer_km": number|null,
  "kind": "car"|"motorbike"|"unknown",
  "confidence": "high"|"medium"|"low"
}

Field: odometer_km
The TOTAL ODOMETER is the lifetime distance the vehicle has driven, in kilometers. It is usually:
- a multi-digit integer (often 5–6 digits),
- located near a small label such as "ODO", "ODOMETER", or simply suffixed with "km",
- displayed in a corner or row of the cluster, NOT at the center.

You MUST NOT return these other numbers as the odometer (they are common decoys):
- The CURRENT SPEED (large central digit(s) followed by "km/h" or "mph") — IGNORE.
- The TACHOMETER / RPM scale numbers (e.g. 0..12 on a motorbike, 0..8 on a car) — IGNORE.
- The TRIP METER (often labeled "TRIP", "A", "B", or shorter than the total odometer) — IGNORE.
- The DISTANCE-TO-EMPTY / range readout (typically next to a fuel-pump icon, e.g. "166 km" with a pump symbol) — IGNORE.
- The COOLANT or AMBIENT TEMPERATURE (followed by °C or °F) — IGNORE.
- Gear indicator, time, or trip number such as "1 26" — IGNORE.

If multiple km values are visible, choose the one that:
1. is labeled "ODO" / "ODOMETER", OR
2. is the largest integer value with a "km" suffix, NOT next to a fuel-pump icon, NOT in the speed area.

If the odometer is unreadable or ambiguous, return odometer_km=null and confidence="low".
Return odometer_km as an INTEGER (round if a decimal trip-style value is shown).

Field: kind
Classify the vehicle by the OVERALL INSTRUMENT-CLUSTER LAYOUT, not by LCD size:
- "motorbike": cluster is a single wide TFT/LCD panel with NO analog speedometer/tachometer dial around it; often shows a bar-style or virtual tach across the top.
- "car": cluster contains one or two LARGE ANALOG ROUND DIALS (speedometer, optionally tachometer), with or without a smaller central display between them; or a wide automotive virtual cluster spanning the width of the binnacle.
- "unknown": if the layout is unclear or the photo is too cropped to tell.

Confidence:
- "high": odometer label visible OR a single unambiguous large km value is present.
- "medium": odometer value plausible but not labeled, multiple km values present.
- "low": no clear odometer or significant glare/blur.

Never invent values; return null / "unknown" when uncertain.`;

type Json = Record<string, unknown>;

type PumpResult = {
  liters: number | null;
  total_price: number | null;
  price_per_liter: number | null;
  currency_hint: string | null;
  fuel_type: string | null;
  confidence: 'high' | 'medium' | 'low';
};

export type CrossCheck = {
  // ok        — all three values present and consistent (within tolerance)
  // derived   — only two of three were read; we computed the missing one
  // mismatch  — all three were read but liters × ppl ≠ total (beyond tolerance)
  // insufficient — fewer than two values were read; nothing to verify
  status: 'ok' | 'derived' | 'mismatch' | 'insufficient';
  // For 'derived': which field we filled in from the other two.
  derived_field?: 'liters' | 'total_price' | 'price_per_liter';
  // For 'mismatch': human-readable description ("39.50 L × 1.78 = 70.31, but total reads 70.64").
  message?: string;
  // Relative error |expected − actual| / actual, when all three are present.
  relative_error?: number;
};

type DashResult = {
  odometer_km: number | null;
  kind: 'car' | 'motorbike' | 'unknown';
  confidence: 'high' | 'medium' | 'low';
};

export type OcrResult = {
  pump: PumpResult | null;
  pump_cross_check: CrossCheck | null;
  dashboard: DashResult | null;
  model: string;
  prompt_version: string;
  raw_pump_response?: string;
  raw_dashboard_response?: string;
  error?: string;
};

function endpointUrl(): string {
  const base = env.AZURE_OPENAI_ENDPOINT!.replace(/\/$/, '');
  return `${base}/openai/deployments/${encodeURIComponent(
    env.AZURE_OPENAI_DEPLOYMENT,
  )}/chat/completions?api-version=${encodeURIComponent(env.AZURE_OPENAI_API_VERSION)}`;
}

async function callVision(
  system: string,
  image: { base64: string; mime: string },
): Promise<{ raw: string; parsed: Json | null }> {
  const body = {
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Extract the requested fields from this image.' },
          {
            type: 'image_url',
            image_url: { url: `data:${image.mime};base64,${image.base64}` },
          },
        ],
      },
    ],
    response_format: { type: 'json_object' },
    // gpt-5.x models reject `max_tokens`; use `max_completion_tokens`.
    // They also only support the default temperature, so we omit it.
    max_completion_tokens: 300,
  };

  const res = await fetch(endpointUrl(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': env.AZURE_OPENAI_API_KEY!,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Azure OpenAI ${res.status}: ${text.slice(0, 500)}`);
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const raw = data.choices?.[0]?.message?.content ?? '';
  let parsed: Json | null = null;
  try {
    parsed = JSON.parse(raw) as Json;
  } catch {
    parsed = null;
  }
  return { raw, parsed };
}

function coercePump(j: Json | null): PumpResult | null {
  if (!j) return null;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : null);
  const conf = (v: unknown): 'high' | 'medium' | 'low' =>
    v === 'high' || v === 'medium' || v === 'low' ? v : 'low';
  return {
    liters: num(j.liters),
    total_price: num(j.total_price),
    price_per_liter: num(j.price_per_liter),
    currency_hint: str(j.currency_hint),
    fuel_type: str(j.fuel_type),
    confidence: conf(j.confidence),
  };
}

function coerceDash(j: Json | null): DashResult | null {
  if (!j) return null;
  const num = (v: unknown) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null;
  const conf = (v: unknown): 'high' | 'medium' | 'low' =>
    v === 'high' || v === 'medium' || v === 'low' ? v : 'low';
  const kind = (v: unknown): 'car' | 'motorbike' | 'unknown' =>
    v === 'car' || v === 'motorbike' ? v : 'unknown';
  return {
    odometer_km: num(j.odometer_km),
    kind: kind(j.kind),
    confidence: conf(j.confidence),
  };
}

function round(n: number, digits: number): number {
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}

// Cross-check pump values: liters × price_per_liter ≈ total_price.
// May MUTATE `pump` (fills in a missing field when exactly two are present and the third can be derived).
// Tolerance: 1% relative + 0.05 absolute on the total (matches the soft warning in the fueling route).
export function crossCheckPump(pump: PumpResult): CrossCheck {
  const { liters, total_price, price_per_liter } = pump;
  const present = [liters, total_price, price_per_liter].filter((v) => v != null && v > 0).length;

  if (present < 2) {
    return { status: 'insufficient' };
  }

  if (present === 2) {
    // Derive the missing one.
    if (liters == null && total_price != null && price_per_liter != null && price_per_liter > 0) {
      pump.liters = round(total_price / price_per_liter, 3);
      return { status: 'derived', derived_field: 'liters' };
    }
    if (total_price == null && liters != null && price_per_liter != null) {
      pump.total_price = round(liters * price_per_liter, 2);
      return { status: 'derived', derived_field: 'total_price' };
    }
    if (price_per_liter == null && liters != null && total_price != null && liters > 0) {
      pump.price_per_liter = round(total_price / liters, 4);
      return { status: 'derived', derived_field: 'price_per_liter' };
    }
    return { status: 'insufficient' };
  }

  // All three present — verify.
  const expectedTotal = (liters as number) * (price_per_liter as number);
  const actualTotal = total_price as number;
  const tolerance = Math.max(actualTotal * 0.01, 0.05);
  const relError = Math.abs(expectedTotal - actualTotal) / actualTotal;

  if (Math.abs(expectedTotal - actualTotal) <= tolerance) {
    return { status: 'ok', relative_error: relError };
  }
  return {
    status: 'mismatch',
    relative_error: relError,
    message: `${(liters as number).toFixed(2)} L × ${(price_per_liter as number).toFixed(3)} = ${expectedTotal.toFixed(2)}, but total reads ${actualTotal.toFixed(2)}.`,
  };
}

export async function runOcr(images: {
  pump?: { base64: string; mime: string };
  dashboard?: { base64: string; mime: string };
}): Promise<OcrResult> {
  if (!isOcrConfigured) {
    return {
      pump: null,
      pump_cross_check: null,
      dashboard: null,
      model: env.AZURE_OPENAI_DEPLOYMENT,
      prompt_version: PROMPT_VERSION,
      error: 'azure_openai_not_configured',
    };
  }

  const tasks: Promise<unknown>[] = [];
  let pumpRaw = '';
  let dashRaw = '';
  let pump: PumpResult | null = null;
  let dashboard: DashResult | null = null;
  let firstError: string | undefined;

  if (images.pump) {
    tasks.push(
      callVision(PUMP_SYSTEM, images.pump)
        .then(({ raw, parsed }) => {
          pumpRaw = raw;
          pump = coercePump(parsed);
        })
        .catch((e: Error) => {
          firstError ??= `pump: ${e.message}`;
        }),
    );
  }
  if (images.dashboard) {
    tasks.push(
      callVision(DASH_SYSTEM, images.dashboard)
        .then(({ raw, parsed }) => {
          dashRaw = raw;
          dashboard = coerceDash(parsed);
        })
        .catch((e: Error) => {
          firstError ??= `dashboard: ${e.message}`;
        }),
    );
  }

  await Promise.all(tasks);

  // Cross-check pump arithmetic (may fill in a derived field).
  const pumpCrossCheck = pump ? crossCheckPump(pump) : null;

  return {
    pump,
    pump_cross_check: pumpCrossCheck,
    dashboard,
    model: env.AZURE_OPENAI_DEPLOYMENT,
    prompt_version: PROMPT_VERSION,
    raw_pump_response: pumpRaw || undefined,
    raw_dashboard_response: dashRaw || undefined,
    error: firstError,
  };
}
