import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { env } from '../env.js';
import { countryToCurrency } from '../services/currency.js';

export const geo = new Hono();

const query = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lon: z.coerce.number().min(-180).max(180),
});

type CacheEntry = { at: number; data: GeoResponse };
type GeoResponse = {
  country_code: string | null;
  currency: string;
  station_name: string | null;
};

const cache = new Map<string, CacheEntry>();
const TTL_MS = 24 * 60 * 60 * 1000;
let lastCallAt = 0;

function cacheKey(lat: number, lon: number) {
  return `${lat.toFixed(3)},${lon.toFixed(3)}`;
}

async function rateLimit() {
  const now = Date.now();
  const wait = Math.max(0, 1100 - (now - lastCallAt));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

geo.get('/lookup', zValidator('query', query), async (c) => {
  const { lat, lon } = c.req.valid('query');
  const key = cacheKey(lat, lon);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < TTL_MS) {
    return c.json(cached.data);
  }

  try {
    await rateLimit();
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=14&addressdetails=1`;
    const res = await fetch(url, {
      headers: { 'User-Agent': env.NOMINATIM_USER_AGENT, 'Accept-Language': 'en' },
    });
    if (!res.ok) throw new Error(`nominatim ${res.status}`);
    const data = (await res.json()) as {
      address?: { country_code?: string };
      name?: string;
      display_name?: string;
    };
    const cc = data.address?.country_code?.toUpperCase() ?? null;
    const response: GeoResponse = {
      country_code: cc,
      currency: (cc && countryToCurrency[cc]) || env.DEFAULT_CURRENCY,
      station_name: data.name || data.display_name?.split(',')[0] || null,
    };
    cache.set(key, { at: Date.now(), data: response });
    return c.json(response);
  } catch (e) {
    const fallback: GeoResponse = {
      country_code: null,
      currency: env.DEFAULT_CURRENCY,
      station_name: null,
    };
    return c.json({ ...fallback, error: (e as Error).message });
  }
});
