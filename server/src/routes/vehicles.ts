import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import {
  createVehicle,
  deleteVehicle,
  getVehicle,
  listVehicles,
  updateVehicle,
} from '../db/vehicles.js';
import { computeVehicleStats, deleteVehicleAndFuelings } from '../db/fuelings.js';

export const vehicles = new Hono();

const vehicleInput = z.object({
  name: z.string().min(1).max(60),
  kind: z.enum(['car', 'motorbike']),
  default_fuel_type: z
    .enum(['diesel', 'gasoline_95', 'gasoline_98', 'e10', 'premium', 'other'])
    .nullable()
    .optional(),
  notes: z.string().max(500).nullable().optional(),
});

vehicles.get('/', async (c) => {
  return c.json(await listVehicles());
});

vehicles.post('/', zValidator('json', vehicleInput), async (c) => {
  const body = c.req.valid('json');
  const created = await createVehicle({
    name: body.name,
    kind: body.kind,
    default_fuel_type: body.default_fuel_type ?? null,
    notes: body.notes ?? null,
  });
  return c.json(created, 201);
});

vehicles.get('/:id/stats', async (c) => {
  const id = c.req.param('id');
  const vehicle = await getVehicle(id);
  if (!vehicle) return c.json({ error: 'not_found' }, 404);
  return c.json(await computeVehicleStats(id));
});

vehicles.patch('/:id', zValidator('json', vehicleInput.partial()), async (c) => {
  const id = c.req.param('id');
  const body = c.req.valid('json');
  const updated = await updateVehicle(id, {
    ...(body.name !== undefined && { name: body.name }),
    ...(body.kind !== undefined && { kind: body.kind }),
    ...(body.default_fuel_type !== undefined && { default_fuel_type: body.default_fuel_type }),
    ...(body.notes !== undefined && { notes: body.notes }),
  });
  if (!updated) return c.json({ error: 'not_found' }, 404);
  return c.json(updated);
});

vehicles.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const cascade = c.req.query('cascade') === 'true';
  if (cascade) {
    const result = await deleteVehicleAndFuelings(id);
    if (!result.vehicle_deleted && result.fuelings_deleted === 0) {
      return c.json({ error: 'not_found' }, 404);
    }
    return c.json(result);
  }
  // Non-cascade: refuse if vehicle has fuelings is not enforced here (Table Storage has no FK).
  // Caller can use ?cascade=true to drop everything.
  const existing = await getVehicle(id);
  if (!existing) return c.json({ error: 'not_found' }, 404);
  await deleteVehicle(id);
  return c.body(null, 204);
});
