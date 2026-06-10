// Helpers for Table Storage keys.
//
// Sort strategy:
//   Table Storage returns entities in (PartitionKey, RowKey) ascending order.
//   OCR attempts use reverse timestamps for newest-first chronological order.
//   Fuelings use a separate date+odometer RowKey so date-only imports can sort
//   newest date first, with higher odometer as the same-day tiebreaker.

import { ulid } from 'ulid';

// Year ~2286. Picked so reverseMs values stay 13 digits even for far-future dates.
const MAX_TIMESTAMP_MS = 9_999_999_999_999;
const MAX_DATE_KEY = 99_999_999;
const MAX_ODOMETER_KM = 99_999_999;

/**
 * Returns a 13-char zero-padded string equal to (MAX - epochMs).
 * Smaller string = later in time. Always 13 digits, lexicographic-safe.
 */
export function reverseTimestamp(epochMs: number): string {
  const r = MAX_TIMESTAMP_MS - epochMs;
  if (r < 0) throw new Error(`reverseTimestamp: epoch ${epochMs} is beyond MAX`);
  return r.toString().padStart(13, '0');
}

/**
 * RowKey for time-ordered entities: <reverse-ts>_<ulid>.
 * - reverse-ts gives newest-first natural ordering when listed ascending.
 * - ULID suffix breaks ties and provides uniqueness even at same ms.
 */
export function timeRowKey(at: Date | string | number = new Date()): string {
  const ms = at instanceof Date ? at.getTime() : typeof at === 'string' ? Date.parse(at) : at;
  if (!Number.isFinite(ms)) throw new Error(`timeRowKey: invalid date ${String(at)}`);
  return `${reverseTimestamp(ms)}_${ulid()}`;
}

function yyyymmddFromFueledAt(fueledAt: string): number {
  const date = fueledAt.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`fuelingRowKey: invalid date ${fueledAt}`);
  }
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error(`fuelingRowKey: invalid date ${fueledAt}`);
  }
  return Number(date.replace(/-/g, ''));
}

/**
 * RowKey for fuelings: <reverse-date>_<reverse-odometer>_<ulid>.
 * Ascending RowKey order yields date DESC, odometer DESC, then uniqueness.
 */
export function fuelingRowKey(fueledAt: string, odometerKm: number): string {
  if (!Number.isInteger(odometerKm) || odometerKm < 0 || odometerKm > MAX_ODOMETER_KM) {
    throw new Error(`fuelingRowKey: invalid odometer ${odometerKm}`);
  }
  const reverseDate = (MAX_DATE_KEY - yyyymmddFromFueledAt(fueledAt)).toString().padStart(8, '0');
  const reverseOdo = (MAX_ODOMETER_KM - odometerKm).toString().padStart(8, '0');
  return `${reverseDate}_${reverseOdo}_${ulid()}`;
}

/** RowKey for entities without natural ordering (e.g. vehicles). */
export function rowKey(): string {
  return ulid();
}

/** Day-bucket PartitionKey: YYYYMMDD in UTC. Used for time-bucketed audit tables. */
export function dayBucket(at: Date | string | number = new Date()): string {
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) throw new Error(`dayBucket: invalid date ${String(at)}`);
  const y = d.getUTCFullYear().toString().padStart(4, '0');
  const m = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = d.getUTCDate().toString().padStart(2, '0');
  return `${y}${m}${day}`;
}

/**
 * Idempotency dedup key for imported fuelings. Re-running the importer with
 * the same source row produces the same key, so existing rows are skipped.
 *
 * Mirrors the (vehicle_id, fueled_at, odo, ROUND(liters,3), ROUND(total,2), currency)
 * uniqueness tuple.
 */
export function buildDedupKey(parts: {
  fueled_at: string;
  odometer_km: number;
  liters: number;
  total_price: number;
  currency: string;
}): string {
  const lit = parts.liters.toFixed(3);
  const tot = parts.total_price.toFixed(2);
  return `${parts.fueled_at}|${parts.odometer_km}|${lit}|${tot}|${parts.currency.toUpperCase()}`;
}

/** Escape a single quote for OData filter literals (Table Storage convention). */
export function odataString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}
