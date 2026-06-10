// Fuelings table.
//
// PartitionKey = vehicle_id (ULID).
// RowKey       = reverse-date_reverse-odometer_ulid. Listing ascending by RowKey
//                returns newest date first, with higher odometer first on ties.

import type { TableEntity } from '@azure/data-tables';
import { getTable } from './client.js';
import { deleteVehicle } from './vehicles.js';
import { fuelingRowKey, odataString } from './keys.js';
import type { FuelType } from './vehicles.js';

export type FillStatus = 'full' | 'partial' | 'unknown';

export type Fueling = {
  id: string;
  vehicle_id: string;
  fueled_at: string;
  odometer_km: number;
  liters: number;
  total_price: number;
  price_per_liter: number;
  currency: string;
  fuel_type: FuelType;
  fill_status: FillStatus;
  latitude: number | null;
  longitude: number | null;
  station_name: string | null;
  country_code: string | null;
  notes: string | null;
  dedup_key: string | null;
  created_at: string;
  // Computed at list time (full-tank model: this fill's liters over distance
  // since the previous fueling). Not stored. Undefined outside list responses.
  consumption_l_per_100km?: number | null;
};

export type FuelingInput = Omit<Fueling, 'id' | 'created_at'>;

export type ListFuelingsResult = {
  items: Fueling[];
  next_cursor: string | null;
};

export type VehicleStats = {
  vehicle_id: string;
  fueling_count: number;
  total_liters: number;
  latest_odometer_km: number | null;
  first_fueled_at: string | null;
  last_fueled_at: string | null;
  total_spend: Record<string, number>;
  avg_consumption_l_per_100km: number | null;
};

type FuelingEntity = TableEntity<{
  fueled_at: string;
  odometer_km: number;
  liters: number;
  total_price: number;
  price_per_liter: number;
  currency: string;
  fuel_type: string;
  fill_status: string;
  latitude: number | null;
  longitude: number | null;
  station_name: string | null;
  country_code: string | null;
  notes: string | null;
  dedup_key: string | null;
  created_at: string;
}>;

function toFueling(e: FuelingEntity): Fueling {
  return {
    id: e.rowKey,
    vehicle_id: e.partitionKey,
    fueled_at: e.fueled_at,
    odometer_km: e.odometer_km,
    liters: e.liters,
    total_price: e.total_price,
    price_per_liter: e.price_per_liter,
    currency: e.currency,
    fuel_type: e.fuel_type as FuelType,
    fill_status: e.fill_status as FillStatus,
    latitude: e.latitude ?? null,
    longitude: e.longitude ?? null,
    station_name: e.station_name ?? null,
    country_code: e.country_code ?? null,
    notes: e.notes ?? null,
    dedup_key: e.dedup_key ?? null,
    created_at: e.created_at,
  };
}

export type ListFuelingsQuery = {
  vehicle_id?: string;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
};

function compareFuelingsNewest(a: Fueling, b: Fueling): number {
  const dateCmp = b.fueled_at.slice(0, 10).localeCompare(a.fueled_at.slice(0, 10));
  if (dateCmp !== 0) return dateCmp;
  const odoCmp = b.odometer_km - a.odometer_km;
  if (odoCmp !== 0) return odoCmp;
  return a.id.localeCompare(b.id);
}

/**
 * Per-fueling consumption (L/100km), full-tank model: this fill's liters over
 * the distance since the previous fueling. Null when there is no previous
 * reading, the distance is non-positive, or the fill spans a known gap
 * (fill_status 'unknown' = a missed fueling, so the segment is unreliable).
 */
function consumptionFor(f: Fueling, prevOdometerKm: number | null): number | null {
  if (prevOdometerKm === null) return null;
  if (f.fill_status === 'unknown') return null;
  const distance = f.odometer_km - prevOdometerKm;
  if (distance <= 0) return null;
  return roundStat((f.liters / distance) * 100, 2);
}

/**
 * List fuelings ordered newest-first by date, then odometer.
 * - If vehicle_id is set, a single partition is queried with real Table pagination.
 * - If not, all partitions are scanned and cursoring is intentionally disabled.
 */
export async function listFuelings(q: ListFuelingsQuery): Promise<ListFuelingsResult> {
  const t = await getTable('fuelings');
  const limit = q.limit ?? 20;

  const filters: string[] = [];
  if (q.vehicle_id) filters.push(`PartitionKey eq ${odataString(q.vehicle_id)}`);
  if (q.from) filters.push(`fueled_at ge ${odataString(q.from)}`);
  if (q.to) filters.push(`fueled_at le ${odataString(q.to)}`);

  const queryOptions = filters.length ? { filter: filters.join(' and ') } : undefined;

  if (q.vehicle_id) {
    const pages = t
      .listEntities<FuelingEntity>({ queryOptions })
      .byPage({ maxPageSize: limit, continuationToken: q.cursor });
    const page = (await pages.next()).value;
    if (!page) return { items: [], next_cursor: null };
    const items = page.map((e: FuelingEntity) => toFueling(e));
    // Items are strictly odometer-descending (RowKey order). Each fueling's
    // previous reading is the next item; for the last item we look one page back.
    for (let i = 0; i < items.length; i++) {
      const prevOdometerKm =
        i < items.length - 1
          ? items[i + 1]!.odometer_km
          : await previousOdometerBelow(q.vehicle_id, items[i]!.odometer_km);
      items[i]!.consumption_l_per_100km = consumptionFor(items[i]!, prevOdometerKm);
    }
    return {
      items,
      next_cursor: page.continuationToken ?? null,
    };
  }

  const out: Fueling[] = [];
  for await (const e of t.listEntities<FuelingEntity>({ queryOptions })) out.push(toFueling(e));
  out.sort(compareFuelingsNewest);
  return { items: out.slice(0, limit), next_cursor: null };
}

export async function getFueling(vehicleId: string, id: string): Promise<Fueling | null> {
  const t = await getTable('fuelings');
  try {
    const e = await t.getEntity<FuelingEntity>(vehicleId, id);
    return toFueling(e);
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) return null;
    throw err;
  }
}

/**
 * Find a fueling by id without knowing the vehicle (partition). Falls back to
 * a cross-partition scan on the unique-but-not-key `id` field. Used by routes
 * that take just an id in the path.
 */
export async function getFuelingById(id: string): Promise<Fueling | null> {
  const t = await getTable('fuelings');
  for await (const e of t.listEntities<FuelingEntity>({
    queryOptions: { filter: `RowKey eq ${odataString(id)}` },
  })) {
    return toFueling(e);
  }
  return null;
}

/**
 * Returns the previous (highest-odometer) fueling for the vehicle at or before
 * a given timestamp. Used for monotonic-odometer enforcement on POST.
 */
export async function previousOdometerKm(
  vehicleId: string,
  atOrBefore: string,
  excludeId?: string,
): Promise<number | null> {
  const t = await getTable('fuelings');
  let max: number | null = null;
  for await (const e of t.listEntities<FuelingEntity>({
    queryOptions: {
      filter:
        `PartitionKey eq ${odataString(vehicleId)} and fueled_at le ${odataString(atOrBefore)}`,
      select: ['RowKey', 'odometer_km'],
    },
  })) {
    if (excludeId && e.rowKey === excludeId) continue;
    if (max === null || e.odometer_km > max) max = e.odometer_km;
  }
  return max;
}

/**
 * Returns the highest odometer reading strictly below the given value for the
 * vehicle (i.e. the previous fueling's odometer). Used to compute per-fueling
 * consumption across a pagination boundary.
 */
export async function previousOdometerBelow(
  vehicleId: string,
  odometerKm: number,
): Promise<number | null> {
  const t = await getTable('fuelings');
  let max: number | null = null;
  for await (const e of t.listEntities<FuelingEntity>({
    queryOptions: {
      filter: `PartitionKey eq ${odataString(vehicleId)} and odometer_km lt ${Math.trunc(odometerKm)}`,
      select: ['odometer_km'],
    },
  })) {
    if (max === null || e.odometer_km > max) max = e.odometer_km;
  }
  return max;
}
export async function findByDedupKey(vehicleId: string, dedupKey: string): Promise<Fueling | null> {
  const t = await getTable('fuelings');
  for await (const e of t.listEntities<FuelingEntity>({
    queryOptions: {
      filter:
        `PartitionKey eq ${odataString(vehicleId)} and dedup_key eq ${odataString(dedupKey)}`,
    },
  })) {
    return toFueling(e);
  }
  return null;
}

export async function createFueling(input: FuelingInput): Promise<Fueling> {
  const t = await getTable('fuelings');
  const id = fuelingRowKey(input.fueled_at, input.odometer_km);
  const now = new Date().toISOString();
  const entity: FuelingEntity = {
    partitionKey: input.vehicle_id,
    rowKey: id,
    fueled_at: input.fueled_at,
    odometer_km: input.odometer_km,
    liters: input.liters,
    total_price: input.total_price,
    price_per_liter: input.price_per_liter,
    currency: input.currency.toUpperCase(),
    fuel_type: input.fuel_type,
    fill_status: input.fill_status,
    latitude: input.latitude ?? null,
    longitude: input.longitude ?? null,
    station_name: input.station_name ?? null,
    country_code: input.country_code ?? null,
    notes: input.notes ?? null,
    dedup_key: input.dedup_key ?? null,
    created_at: now,
  };
  await t.createEntity(entity);
  return toFueling(entity);
}

export async function updateFueling(
  id: string,
  patch: Partial<Omit<FuelingInput, 'vehicle_id'>>,
): Promise<Fueling | null> {
  const existing = await getFuelingById(id);
  if (!existing) return null;
  const merged: Fueling = { ...existing, ...patch };
  const t = await getTable('fuelings');

  // The RowKey encodes fueled_at + odometer_km, so changing either moves the row.
  // Table Storage can't rename a key in place — write the new row, then drop the
  // old one (create-before-delete so a mid-flight failure never loses data).
  const keyChanged =
    merged.fueled_at !== existing.fueled_at || merged.odometer_km !== existing.odometer_km;

  if (keyChanged) {
    const newId = fuelingRowKey(merged.fueled_at, merged.odometer_km);
    const entity: FuelingEntity = {
      partitionKey: existing.vehicle_id,
      rowKey: newId,
      fueled_at: merged.fueled_at,
      odometer_km: merged.odometer_km,
      liters: merged.liters,
      total_price: merged.total_price,
      price_per_liter: merged.price_per_liter,
      currency: merged.currency.toUpperCase(),
      fuel_type: merged.fuel_type,
      fill_status: merged.fill_status,
      latitude: merged.latitude,
      longitude: merged.longitude,
      station_name: merged.station_name,
      country_code: merged.country_code,
      notes: merged.notes,
      dedup_key: merged.dedup_key,
      created_at: merged.created_at,
    };
    await t.createEntity(entity);
    await t.deleteEntity(existing.vehicle_id, id);
    return toFueling(entity);
  }

  await t.updateEntity(
    {
      partitionKey: existing.vehicle_id,
      rowKey: id,
      fueled_at: merged.fueled_at,
      odometer_km: merged.odometer_km,
      liters: merged.liters,
      total_price: merged.total_price,
      price_per_liter: merged.price_per_liter,
      currency: merged.currency.toUpperCase(),
      fuel_type: merged.fuel_type,
      fill_status: merged.fill_status,
      latitude: merged.latitude,
      longitude: merged.longitude,
      station_name: merged.station_name,
      country_code: merged.country_code,
      notes: merged.notes,
      dedup_key: merged.dedup_key,
      created_at: merged.created_at,
    } satisfies FuelingEntity,
    'Replace',
  );
  return { ...merged, id, vehicle_id: existing.vehicle_id };
}

export async function deleteFueling(id: string): Promise<boolean> {
  const existing = await getFuelingById(id);
  if (!existing) return false;
  const t = await getTable('fuelings');
  await t.deleteEntity(existing.vehicle_id, id);
  return true;
}

function roundStat(n: number, digits: number): number {
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}

export async function computeVehicleStats(vehicleId: string): Promise<VehicleStats> {
  const t = await getTable('fuelings');
  let fuelingCount = 0;
  let totalLiters = 0;
  let latestOdometerKm: number | null = null;
  let firstDate: string | null = null;
  let firstFueledAt: string | null = null;
  let lastDate: string | null = null;
  let lastFueledAt: string | null = null;
  const totalSpend: Record<string, number> = {};
  const consumptionRows: { odometer_km: number; liters: number }[] = [];

  for await (const e of t.listEntities<FuelingEntity>({
    queryOptions: { filter: `PartitionKey eq ${odataString(vehicleId)}` },
  })) {
    const f = toFueling(e);
    fuelingCount++;
    totalLiters += f.liters;
    if (latestOdometerKm === null || f.odometer_km > latestOdometerKm) {
      latestOdometerKm = f.odometer_km;
    }

    const date = f.fueled_at.slice(0, 10);
    if (firstDate === null || date < firstDate) {
      firstDate = date;
      firstFueledAt = f.fueled_at;
    }
    if (lastDate === null || date > lastDate) {
      lastDate = date;
      lastFueledAt = f.fueled_at;
    }

    const currency = f.currency.toUpperCase();
    totalSpend[currency] = (totalSpend[currency] ?? 0) + f.total_price;
    consumptionRows.push({ odometer_km: f.odometer_km, liters: f.liters });
  }

  let avgConsumption: number | null = null;
  if (consumptionRows.length >= 2) {
    consumptionRows.sort((a, b) => a.odometer_km - b.odometer_km);
    const minOdo = consumptionRows[0]!.odometer_km;
    const maxOdo = consumptionRows[consumptionRows.length - 1]!.odometer_km;
    const distance = maxOdo - minOdo;
    if (distance > 0) {
      const litersExcludingEarliest = consumptionRows.slice(1).reduce((sum, r) => sum + r.liters, 0);
      avgConsumption = roundStat((litersExcludingEarliest / distance) * 100, 2);
    }
  }

  return {
    vehicle_id: vehicleId,
    fueling_count: fuelingCount,
    total_liters: roundStat(totalLiters, 3),
    latest_odometer_km: latestOdometerKm,
    first_fueled_at: firstFueledAt,
    last_fueled_at: lastFueledAt,
    total_spend: Object.fromEntries(
      Object.entries(totalSpend).map(([currency, value]) => [currency, roundStat(value, 2)]),
    ),
    avg_consumption_l_per_100km: avgConsumption,
  };
}

/**
 * Cascade-delete: removes all fuelings for a vehicle, then the vehicle itself.
 * Table Storage has no FK; we do this in code. Batched per 100 entities.
 */
export async function deleteVehicleAndFuelings(vehicleId: string): Promise<{
  vehicle_deleted: boolean;
  fuelings_deleted: number;
}> {
  const t = await getTable('fuelings');
  const ids: string[] = [];
  for await (const e of t.listEntities<FuelingEntity>({
    queryOptions: { filter: `PartitionKey eq ${odataString(vehicleId)}`, select: ['RowKey'] },
  })) {
    ids.push(e.rowKey);
  }
  // Batch delete in chunks of 100 (Table Storage batch limit, same partition).
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    if (chunk.length === 1) {
      await t.deleteEntity(vehicleId, chunk[0]!);
    } else {
      await t.submitTransaction(chunk.map((rk) => ['delete', { partitionKey: vehicleId, rowKey: rk }]));
    }
  }
  const vehicleDeleted = await deleteVehicle(vehicleId);
  return { vehicle_deleted: vehicleDeleted, fuelings_deleted: ids.length };
}
