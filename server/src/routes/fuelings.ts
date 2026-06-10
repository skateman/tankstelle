import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import {
  createFueling,
  deleteFueling,
  getFuelingById,
  listFuelings,
  previousOdometerKm,
  updateFueling,
} from '../db/fuelings.js';

export const fuelings = new Hono();

const fuelingInput = z.object({
  vehicle_id: z.string().min(1),
  fueled_at: z.string().date(),
  odometer_km: z.number().int().nonnegative(),
  liters: z.number().positive(),
  total_price: z.number().positive(),
  price_per_liter: z.number().positive(),
  currency: z.string().length(3),
  fuel_type: z.enum(['diesel', 'gasoline_95', 'gasoline_98', 'e10', 'premium', 'other']),
  fill_status: z.enum(['full', 'partial', 'unknown']).default('full'),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  station_name: z.string().max(120).nullable().optional(),
  country_code: z.string().length(2).nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
  allow_odometer_regression: z.boolean().optional(),
});

const listQuery = z.object({
  vehicle_id: z.string().min(1).optional(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  limit: z.coerce.number().int().positive().max(500).default(20),
  cursor: z.string().min(1).optional(),
});

fuelings.get('/', zValidator('query', listQuery), async (c) => {
  const q = c.req.valid('query');
  const page = await listFuelings({
    vehicle_id: q.vehicle_id,
    from: q.from,
    to: q.to,
    limit: q.limit,
    cursor: q.cursor,
  });
  return c.json(page);
});

fuelings.post('/', zValidator('json', fuelingInput), async (c) => {
  const body = c.req.valid('json');

  if (!body.allow_odometer_regression) {
    const prev = await previousOdometerKm(body.vehicle_id, body.fueled_at);
    if (prev !== null && body.odometer_km < prev) {
      return c.json(
        {
          error: 'odometer_regression',
          message: `Odometer ${body.odometer_km} is lower than previous reading ${prev}. Resubmit with allow_odometer_regression=true to override.`,
          previous_odometer_km: prev,
        },
        409,
      );
    }
  }

  const created = await createFueling({
    vehicle_id: body.vehicle_id,
    fueled_at: body.fueled_at,
    odometer_km: body.odometer_km,
    liters: body.liters,
    total_price: body.total_price,
    price_per_liter: body.price_per_liter,
    currency: body.currency.toUpperCase(),
    fuel_type: body.fuel_type,
    fill_status: body.fill_status,
    latitude: body.latitude ?? null,
    longitude: body.longitude ?? null,
    station_name: body.station_name ?? null,
    country_code: body.country_code ?? null,
    notes: body.notes ?? null,
    dedup_key: null,
  });

  // Soft sanity: liters * ppl ~= total_price (1% tolerance + 0.05 absolute).
  const expected = body.liters * body.price_per_liter;
  const tolerance = Math.max(expected * 0.01, 0.05);
  const warnings: string[] = [];
  if (Math.abs(expected - body.total_price) > tolerance) {
    warnings.push(
      `liters * price_per_liter (${expected.toFixed(2)}) differs from total_price (${body.total_price.toFixed(2)}) by more than tolerance.`,
    );
  }

  return c.json({ ...created, warnings }, 201);
});

fuelings.get('/:id', async (c) => {
  const id = c.req.param('id');
  const fueling = await getFuelingById(id);
  if (!fueling) return c.json({ error: 'not_found' }, 404);
  return c.json(fueling);
});

fuelings.patch('/:id', zValidator('json', fuelingInput.partial()), async (c) => {
  const id = c.req.param('id');
  const existing = await getFuelingById(id);
  if (!existing) return c.json({ error: 'not_found' }, 404);

  const body = c.req.valid('json');
  // vehicle_id is the partition key — moving rows across partitions is not supported in-place.
  if (body.vehicle_id && body.vehicle_id !== existing.vehicle_id) {
    return c.json(
      { error: 'vehicle_id_immutable', message: 'Delete and re-create to move a fueling to another vehicle.' },
      400,
    );
  }

  const nextFueledAt = body.fueled_at ?? existing.fueled_at;
  const nextOdometerKm = body.odometer_km ?? existing.odometer_km;

  if (!body.allow_odometer_regression) {
    // Compare against other fuelings only — exclude the row being edited so it
    // isn't measured against itself.
    const prev = await previousOdometerKm(existing.vehicle_id, nextFueledAt, id);
    if (prev !== null && nextOdometerKm < prev) {
      return c.json(
        {
          error: 'odometer_regression',
          message: `Odometer ${nextOdometerKm} is lower than previous reading ${prev}. Resubmit with allow_odometer_regression=true to override.`,
          previous_odometer_km: prev,
        },
        409,
      );
    }
  }

  const updated = await updateFueling(id, {
    ...(body.fueled_at !== undefined && { fueled_at: body.fueled_at }),
    ...(body.odometer_km !== undefined && { odometer_km: body.odometer_km }),
    ...(body.liters !== undefined && { liters: body.liters }),
    ...(body.total_price !== undefined && { total_price: body.total_price }),
    ...(body.price_per_liter !== undefined && { price_per_liter: body.price_per_liter }),
    ...(body.currency !== undefined && { currency: body.currency.toUpperCase() }),
    ...(body.fuel_type !== undefined && { fuel_type: body.fuel_type }),
    ...(body.fill_status !== undefined && { fill_status: body.fill_status }),
    ...(body.latitude !== undefined && { latitude: body.latitude }),
    ...(body.longitude !== undefined && { longitude: body.longitude }),
    ...(body.station_name !== undefined && { station_name: body.station_name }),
    ...(body.country_code !== undefined && { country_code: body.country_code }),
    ...(body.notes !== undefined && { notes: body.notes }),
  });
  return c.json(updated);
});

fuelings.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const ok = await deleteFueling(id);
  if (!ok) return c.json({ error: 'not_found' }, 404);
  return c.body(null, 204);
});
