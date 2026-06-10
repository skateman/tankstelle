// CSV importer for Motomoshi-format vehicle exports (also used by carspending.com).
//
// Usage:
//   npm run -w server import:motomoshi -- <csv-path> --vehicle-id <ULID> [options]
//   npm run -w server import:motomoshi -- <csv-path> --vehicle-name "X" [options]
//   npm run -w server import:motomoshi -- <csv-path> --create-vehicle --name "X" --kind car|motorbike [options]
//
// Options:
//   --fuel-type FT            Tankstelle fuel type for imported rows (default: gasoline_95)
//                             One of: diesel|gasoline_95|gasoline_98|e10|premium|other
//   --dry-run                 Parse, validate, print summary; do not write to DB.
//
// Notes:
//   - Motomoshi CSV has only date (no time); we store fueled_at as YYYY-MM-DD.
//   - Motomoshi only encodes "gasoline" as a fuel type; map via --fuel-type.
//   - Idempotency: rows with the same (vehicle, fueled_at, odo, liters, total, currency) dedup key
//     are skipped on re-runs.
//   - Rows with "Has missed" = 1 are imported with fill_status='unknown' (consumption discontinuity).
//   - Expenses are NOT imported (no expenses table); a summary of ignored rows is printed.

import { parse } from 'csv-parse/sync';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  createFueling,
  findByDedupKey,
} from '../db/fuelings.js';
import {
  createVehicle,
  findVehicleByName,
  getVehicle,
} from '../db/vehicles.js';
import { buildDedupKey } from '../db/keys.js';

const FUEL_TYPES = ['diesel', 'gasoline_95', 'gasoline_98', 'e10', 'premium', 'other'] as const;
type FuelType = (typeof FUEL_TYPES)[number];

const KINDS = ['car', 'motorbike'] as const;
type Kind = (typeof KINDS)[number];

type Args = {
  csvPath: string;
  vehicleId?: string;
  vehicleName?: string;
  createVehicle: boolean;
  name?: string;
  kind?: Kind;
  fuelType: FuelType;
  dryRun: boolean;
};

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  console.error('Run with --help for usage.');
  process.exit(1);
}

function printHelp(): void {
  console.log(`Motomoshi CSV importer

Usage:
  import:motomoshi <csv-path> --vehicle-id <ULID> [options]
  import:motomoshi <csv-path> --vehicle-name "X" [options]
  import:motomoshi <csv-path> --create-vehicle --name "X" --kind car|motorbike [options]

Options:
  --vehicle-id <ULID>       Import into existing vehicle by id.
  --vehicle-name "X"        Import into existing vehicle by exact name (case-sensitive).
  --create-vehicle          Create a new vehicle (requires --name and --kind).
  --name "X"                Name for new vehicle.
  --kind car|motorbike      Kind for new vehicle.
  --fuel-type FT            Tankstelle fuel type (default: gasoline_95).
                            One of: ${FUEL_TYPES.join('|')}
  --dry-run                 Parse, validate, print summary; do not write.
  -h, --help                Show this help.
`);
}

function parseArgs(argv: string[]): Args {
  const a: Partial<Args> = {
    createVehicle: false,
    fuelType: 'gasoline_95',
    dryRun: false,
  };
  const positional: string[] = [];
  const next = (i: number, flag: string): string => {
    const v = argv[i];
    if (v === undefined) fail(`${flag} requires a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === undefined) continue;
    switch (t) {
      case '-h':
      case '--help':
        printHelp();
        process.exit(0);
        break;
      case '--vehicle-id': {
        a.vehicleId = next(++i, t);
        break;
      }
      case '--vehicle-name': {
        a.vehicleName = next(++i, t);
        break;
      }
      case '--create-vehicle':
        a.createVehicle = true;
        break;
      case '--name':
        a.name = next(++i, t);
        break;
      case '--kind': {
        const v = next(++i, t);
        if (!(KINDS as readonly string[]).includes(v)) fail(`--kind must be one of ${KINDS.join('|')}`);
        a.kind = v as Kind;
        break;
      }
      case '--fuel-type': {
        const v = next(++i, t);
        if (!(FUEL_TYPES as readonly string[]).includes(v)) fail(`--fuel-type must be one of ${FUEL_TYPES.join('|')}`);
        a.fuelType = v as FuelType;
        break;
      }
      case '--dry-run':
        a.dryRun = true;
        break;
      default:
        if (t.startsWith('--')) fail(`unknown flag: ${t}`);
        positional.push(t);
    }
  }
  if (positional.length !== 1) fail('exactly one <csv-path> is required');
  a.csvPath = positional[0];

  const selectorCount =
    (a.vehicleId ? 1 : 0) + (a.vehicleName ? 1 : 0) + (a.createVehicle ? 1 : 0);
  if (selectorCount === 0) {
    fail('one of --vehicle-id, --vehicle-name, or --create-vehicle is required');
  }
  if (selectorCount > 1) {
    fail('--vehicle-id, --vehicle-name, and --create-vehicle are mutually exclusive');
  }
  if (a.createVehicle && (!a.name || !a.kind)) {
    fail('--create-vehicle requires both --name and --kind');
  }
  return a as Args;
}

type Section = 'fuelings' | 'expenses' | 'units' | null;

function splitSections(csv: string): { fuelings: string[][]; expenses: string[][] } {
  // Normalize BOM + CRLF.
  let text = csv;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.replace(/\r\n?/g, '\n');

  const lines = text.split('\n');
  let section: Section = null;
  const sectionLines: Record<'units' | 'fuelings' | 'expenses', string[]> = {
    units: [],
    fuelings: [],
    expenses: [],
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '## Units') {
      section = 'units';
      continue;
    }
    if (line === '## Fuelings') {
      section = 'fuelings';
      continue;
    }
    if (line === '## Expenses') {
      section = 'expenses';
      continue;
    }
    if (section && raw.length > 0) sectionLines[section].push(raw);
  }

  // Use csv-parse to handle quoted commas and quote escapes correctly.
  const parseRows = (ls: string[]): string[][] =>
    ls.length ? (parse(ls.join('\n'), { relax_column_count: true }) as string[][]) : [];

  return {
    fuelings: parseRows(sectionLines.fuelings),
    expenses: parseRows(sectionLines.expenses),
  };
}

const ParsedFuelingRow = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  odometer_km: z.number().int().nonnegative(),
  total_price: z.number().positive(),
  currency: z.string().length(3).regex(/^[A-Z]{3}$/),
  liters: z.number().positive(),
  is_partial: z.boolean(),
  has_missed: z.boolean(),
  notes: z.string().nullable(),
});

type ParsedFuelingRow = z.infer<typeof ParsedFuelingRow>;

function parseFuelingRows(rows: string[][]): {
  parsed: ParsedFuelingRow[];
  errors: { row: number; reason: string; raw: string[] }[];
} {
  if (rows.length === 0) return { parsed: [], errors: [] };
  const header = rows[0]!;
  const expected = ['Date', 'Odometer', 'Total', 'Currency', 'Quantity', 'Fuel Type', 'Is partial', 'Has missed', 'Notes'];
  for (let i = 0; i < expected.length; i++) {
    if (header[i] !== expected[i]) {
      throw new Error(
        `Unexpected fueling column ${i}: expected "${expected[i]}", got "${header[i]}". Is this a Motomoshi-format CSV?`,
      );
    }
  }

  const parsed: ParsedFuelingRow[] = [];
  const errors: { row: number; reason: string; raw: string[] }[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    if (r.length === 0 || (r.length === 1 && (r[0] ?? '').trim() === '')) continue;
    const candidate = {
      date: (r[0] ?? '').trim(),
      odometer_km: Number(r[1] ?? ''),
      total_price: Number(r[2] ?? ''),
      currency: (r[3] ?? '').trim().toUpperCase(),
      liters: Number(r[4] ?? ''),
      is_partial: r[6] === '1',
      has_missed: r[7] === '1',
      notes: r[8] && r[8].trim() ? r[8].trim() : null,
    };
    const parsedRow = ParsedFuelingRow.safeParse(candidate);
    if (!parsedRow.success) {
      errors.push({
        row: i + 1,
        reason: parsedRow.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; '),
        raw: r,
      });
      continue;
    }
    parsed.push(parsedRow.data);
  }
  return { parsed, errors };
}

function round(n: number, digits: number): number {
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}

function buildFueledAt(date: string): string {
  return date;
}

function summary(label: string, parsed: ParsedFuelingRow[]): void {
  if (parsed.length === 0) {
    console.log(`  ${label}: (empty)`);
    return;
  }
  const dates = parsed.map((p) => p.date).sort();
  const odos = parsed.map((p) => p.odometer_km).sort((a, b) => a - b);
  const currencies = new Set(parsed.map((p) => p.currency));
  const partials = parsed.filter((p) => p.is_partial).length;
  const missed = parsed.filter((p) => p.has_missed).length;
  const litersTotal = parsed.reduce((s, p) => s + p.liters, 0);
  console.log(`  ${label}: ${parsed.length} rows`);
  console.log(`    date range: ${dates[0]} → ${dates[dates.length - 1]}`);
  console.log(`    odometer  : ${odos[0]} → ${odos[odos.length - 1]} km`);
  console.log(`    currencies: ${[...currencies].sort().join(', ')}`);
  console.log(`    partials  : ${partials}`);
  console.log(`    has-missed: ${missed}`);
  console.log(`    liters Σ  : ${litersTotal.toFixed(2)}`);
}

async function resolveVehicle(args: Args): Promise<{ id: string; label: string }> {
  if (args.createVehicle) {
    if (args.dryRun) {
      return {
        id: '(dry-run)',
        label: `would create: name="${args.name}", kind=${args.kind}, default_fuel_type=${args.fuelType}`,
      };
    }
    const v = await createVehicle({
      name: args.name!,
      kind: args.kind!,
      default_fuel_type: args.fuelType,
      notes: null,
    });
    return { id: v.id, label: `created id=${v.id}: "${v.name}" (${v.kind})` };
  }
  if (args.vehicleName) {
    const v = await findVehicleByName(args.vehicleName);
    if (!v) fail(`no vehicle found with name "${args.vehicleName}"`);
    return { id: v.id, label: `target id=${v.id}: "${v.name}" (${v.kind})` };
  }
  const v = await getVehicle(args.vehicleId!);
  if (!v) fail(`vehicle id ${args.vehicleId} does not exist`);
  return { id: v.id, label: `target id=${v.id}: "${v.name}" (${v.kind})` };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let csvText: string;
  try {
    csvText = readFileSync(args.csvPath, 'utf8');
  } catch (e) {
    fail(`cannot read CSV file at ${args.csvPath}: ${(e as Error).message}`);
  }

  const { fuelings: fRows, expenses: eRows } = splitSections(csvText);
  const { parsed, errors } = parseFuelingRows(fRows);

  const vehicle = await resolveVehicle(args);
  console.log(vehicle.label);

  console.log(`\nParsed CSV: ${args.csvPath}`);
  summary('fuelings (valid)', parsed);
  if (errors.length) {
    console.log(`  fuelings (errors): ${errors.length}`);
    for (const e of errors.slice(0, 5)) {
      console.log(`    row ${e.row}: ${e.reason} :: ${JSON.stringify(e.raw)}`);
    }
    if (errors.length > 5) console.log(`    … and ${errors.length - 5} more`);
  }
  const expenseDataRows = Math.max(0, eRows.length - 1);
  console.log(`  expenses (ignored): ${expenseDataRows} rows (Tankstelle has no expenses table)`);
  if (eRows.length > 1) {
    const expHeader = eRows[0]!;
    for (let i = 1; i < eRows.length; i++) {
      const r = eRows[i];
      if (!r) continue;
      if (r.length === 0 || (r.length === 1 && (r[0] ?? '').trim() === '')) continue;
      const map = Object.fromEntries(expHeader.map((h, k) => [h, r[k]]));
      console.log(
        `    ${map.Date} odo=${map.Odometer} ${map.Total ?? ''} ${map.Currency ?? ''} :: ${map.Category} ${
          map.Notes ? `(${map.Notes})` : ''
        }`,
      );
    }
  }

  if (errors.length > 0) {
    fail(`refusing to import: ${errors.length} row(s) failed validation`);
  }

  if (args.dryRun) {
    console.log('\n(dry-run) no changes written.');
    return;
  }

  let inserted = 0;
  let skipped = 0;
  const sanityWarnings: { date: string; expected: number; actual: number }[] = [];

  for (const r of parsed) {
    const fueled_at = buildFueledAt(r.date);
    const liters = round(r.liters, 3);
    const total_price = round(r.total_price, 2);
    const price_per_liter = round(total_price / liters, 4);
    const fill_status = r.has_missed ? 'unknown' : r.is_partial ? 'partial' : 'full';

    const expected = liters * price_per_liter;
    const tolerance = Math.max(expected * 0.01, 0.05);
    if (Math.abs(expected - total_price) > tolerance) {
      sanityWarnings.push({ date: r.date, expected, actual: total_price });
    }

    const dedup_key = buildDedupKey({
      fueled_at,
      odometer_km: r.odometer_km,
      liters,
      total_price,
      currency: r.currency,
    });
    const dup = await findByDedupKey(vehicle.id, dedup_key);
    if (dup) {
      skipped++;
      continue;
    }
    await createFueling({
      vehicle_id: vehicle.id,
      fueled_at,
      odometer_km: r.odometer_km,
      liters,
      total_price,
      price_per_liter,
      currency: r.currency,
      fuel_type: args.fuelType,
      fill_status,
      latitude: null,
      longitude: null,
      station_name: null,
      country_code: null,
      notes: r.notes,
      dedup_key,
    });
    inserted++;
  }

  console.log(`\nImport complete.`);
  console.log(`  inserted: ${inserted}`);
  console.log(`  skipped (duplicates): ${skipped}`);
  if (sanityWarnings.length) {
    console.log(`  sanity-check warnings: ${sanityWarnings.length} (liters × price/L vs total mismatch)`);
    for (const w of sanityWarnings.slice(0, 3)) {
      console.log(`    ${w.date}: expected ≈ ${w.expected.toFixed(2)}, actual = ${w.actual.toFixed(2)}`);
    }
    if (sanityWarnings.length > 3) console.log(`    … and ${sanityWarnings.length - 3} more`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack || e.message : e);
  process.exit(1);
});
