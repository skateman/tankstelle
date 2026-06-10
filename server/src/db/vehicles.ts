// Vehicles table.
//
// PartitionKey = "v" (single partition; we have a handful of vehicles total).
// RowKey       = ULID.

import type { TableEntity } from '@azure/data-tables';
import { getTable } from './client.js';
import { odataString, rowKey } from './keys.js';

const PK = 'v';

const FUEL_TYPES = ['diesel', 'gasoline_95', 'gasoline_98', 'e10', 'premium', 'other'] as const;
export type FuelType = (typeof FUEL_TYPES)[number];

export type Vehicle = {
  id: string;
  name: string;
  kind: 'car' | 'motorbike';
  default_fuel_type: FuelType | null;
  notes: string | null;
  created_at: string;
};

export type VehicleInput = Omit<Vehicle, 'id' | 'created_at'>;

type VehicleEntity = TableEntity<{
  name: string;
  kind: 'car' | 'motorbike';
  default_fuel_type: string | null;
  notes: string | null;
  created_at: string;
}>;

function toVehicle(e: VehicleEntity): Vehicle {
  return {
    id: e.rowKey,
    name: e.name,
    kind: e.kind,
    default_fuel_type: (e.default_fuel_type as FuelType | null) ?? null,
    notes: e.notes ?? null,
    created_at: e.created_at,
  };
}

export async function listVehicles(): Promise<Vehicle[]> {
  const t = await getTable('vehicles');
  const out: Vehicle[] = [];
  for await (const e of t.listEntities<VehicleEntity>({
    queryOptions: { filter: `PartitionKey eq ${odataString(PK)}` },
  })) {
    out.push(toVehicle(e));
  }
  out.sort((a, b) => a.created_at.localeCompare(b.created_at));
  return out;
}

export async function getVehicle(id: string): Promise<Vehicle | null> {
  const t = await getTable('vehicles');
  try {
    const e = await t.getEntity<VehicleEntity>(PK, id);
    return toVehicle(e);
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) return null;
    throw err;
  }
}

/** Look up a vehicle by exact name. Used by the importer for --vehicle-name. */
export async function findVehicleByName(name: string): Promise<Vehicle | null> {
  const t = await getTable('vehicles');
  for await (const e of t.listEntities<VehicleEntity>({
    queryOptions: {
      filter: `PartitionKey eq ${odataString(PK)} and name eq ${odataString(name)}`,
    },
  })) {
    return toVehicle(e);
  }
  return null;
}

export async function createVehicle(input: VehicleInput): Promise<Vehicle> {
  const t = await getTable('vehicles');
  const id = rowKey();
  const now = new Date().toISOString();
  const entity: VehicleEntity = {
    partitionKey: PK,
    rowKey: id,
    name: input.name,
    kind: input.kind,
    default_fuel_type: input.default_fuel_type ?? null,
    notes: input.notes ?? null,
    created_at: now,
  };
  await t.createEntity(entity);
  return toVehicle(entity);
}

export async function updateVehicle(
  id: string,
  patch: Partial<VehicleInput>,
): Promise<Vehicle | null> {
  const existing = await getVehicle(id);
  if (!existing) return null;
  const merged: Vehicle = {
    ...existing,
    ...patch,
    default_fuel_type: patch.default_fuel_type ?? existing.default_fuel_type,
    notes: patch.notes !== undefined ? patch.notes : existing.notes,
  };
  const t = await getTable('vehicles');
  await t.updateEntity(
    {
      partitionKey: PK,
      rowKey: id,
      name: merged.name,
      kind: merged.kind,
      default_fuel_type: merged.default_fuel_type,
      notes: merged.notes,
      created_at: merged.created_at,
    } satisfies VehicleEntity,
    'Replace',
  );
  return merged;
}

export async function deleteVehicle(id: string): Promise<boolean> {
  const t = await getTable('vehicles');
  try {
    await t.deleteEntity(PK, id);
    return true;
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) return false;
    throw err;
  }
}
