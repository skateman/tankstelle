import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  api,
  FUEL_TYPES,
  type FillStatus,
  type FuelType,
  type GeoLookup,
  type OcrCrossCheck,
  type OcrResponse,
  type Vehicle,
} from '../lib/api';
import { todayLocal } from '../lib/format';
import { preprocessImage } from '../lib/image';
import { getPosition } from '../lib/geo';
import InAppCamera from '../components/InAppCamera';

type CaptureMode = 'idle' | 'camera';
type Step = 1 | 2;
type EntryMode = 'photo' | 'manual';

export default function NewFueling() {
  const nav = useNavigate();
  const [searchParams] = useSearchParams();
  const requestedVehicleId = searchParams.get('vehicle_id') ?? '';
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [defaultCurrency, setDefaultCurrency] = useState('EUR');

  const [step, setStep] = useState<Step>(1);
  const [entryMode, setEntryMode] = useState<EntryMode>('photo');

  const [pump, setPump] = useState<File | null>(null);
  const [dash, setDash] = useState<File | null>(null);
  const [pumpMode, setPumpMode] = useState<CaptureMode>('idle');
  const [dashMode, setDashMode] = useState<CaptureMode>('idle');
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrError, setOcrError] = useState<string | null>(null);

  const [vehicleId, setVehicleId] = useState<string>(requestedVehicleId);
  const [fueledAt, setFueledAt] = useState<string>(todayLocal());
  const [odometerKm, setOdometerKm] = useState<string>('');
  const [liters, setLiters] = useState<string>('');
  const [totalPrice, setTotalPrice] = useState<string>('');
  const [pricePerLiter, setPricePerLiter] = useState<string>('');
  const [currency, setCurrency] = useState<string>('EUR');
  const [fuelType, setFuelType] = useState<FuelType>('gasoline_95');
  const [fillStatus, setFillStatus] = useState<FillStatus>('full');
  const [countryCode, setCountryCode] = useState<string | null>(null);
  const [coords, setCoords] = useState<{ latitude: number; longitude: number } | null>(null);
  const [notes, setNotes] = useState<string>('');
  const [autoVehicleHint, setAutoVehicleHint] = useState<{
    kind: 'car' | 'motorbike' | 'unknown';
    confidence: 'high' | 'medium' | 'low';
  } | null>(null);
  const [crossCheck, setCrossCheck] = useState<OcrCrossCheck | null>(null);
  const [ocrDebug, setOcrDebug] = useState<{
    model?: string;
    prompt_version?: string;
    raw_pump_response?: string | null;
    raw_dashboard_response?: string | null;
  } | null>(null);

  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    api.vehicles.list().then((v) => {
      setVehicles(v);
    });
  }, []);

  useEffect(() => {
    if (requestedVehicleId) setVehicleId(requestedVehicleId);
  }, [requestedVehicleId]);

  useEffect(() => {
    // Kick off geolocation as soon as the form mounts.
    getPosition().then(async (pos) => {
      if (!pos) return;
      setCoords(pos);
      try {
        const g: GeoLookup = await api.geo.lookup(pos.latitude, pos.longitude);
        setCountryCode(g.country_code);
        setCurrency(g.currency);
        setDefaultCurrency(g.currency);
      } catch {
        // ignore
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function captureShot(file: File, target: 'pump' | 'dash') {
    const processed = await preprocessImage(file).catch(() => file);
    if (target === 'pump') {
      setPump(processed);
      setPumpMode('idle');
    } else {
      setDash(processed);
      setDashMode('idle');
    }
  }

  async function runOcr() {
    if (!pump && !dash) return;
    setOcrBusy(true);
    setOcrError(null);
    setCrossCheck(null);
    setOcrDebug(null);
    try {
      const r: OcrResponse = await api.ocr.pump(pump, dash);
      setOcrDebug({
        model: r.model,
        prompt_version: r.prompt_version,
        raw_pump_response: r.raw_pump_response,
        raw_dashboard_response: r.raw_dashboard_response,
      });
      if (r.error) setOcrError(r.error);
      if (r.pump) {
        if (r.pump.liters != null) setLiters(String(r.pump.liters));
        if (r.pump.total_price != null) setTotalPrice(String(r.pump.total_price));
        if (r.pump.price_per_liter != null) setPricePerLiter(String(r.pump.price_per_liter));
        if (r.pump.currency_hint) setCurrency(r.pump.currency_hint);
        if (r.pump.fuel_type) setFuelType(r.pump.fuel_type);
      }
      setCrossCheck(r.pump_cross_check);
      if (r.dashboard) {
        if (r.dashboard.odometer_km != null) setOdometerKm(String(r.dashboard.odometer_km));
        setAutoVehicleHint({ kind: r.dashboard.kind, confidence: r.dashboard.confidence });
        if (
          r.dashboard.kind !== 'unknown' &&
          r.dashboard.confidence === 'high' &&
          vehicleId === ''
        ) {
          const match = vehicles.find((v) => v.kind === r.dashboard!.kind);
          if (match) setVehicleId(match.id);
        }
      }
    } catch (e) {
      setOcrError((e as Error).message);
    } finally {
      setOcrBusy(false);
    }
  }

  function num(s: string, name: string): number {
    const n = Number(s);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`);
    return n;
  }

  async function nextFromPhoto() {
    setFormError(null);
    if (!pump && !dash) {
      setFormError('Take at least one photo first.');
      return;
    }
    await runOcr();
    setStep(2);
  }

  function nextFromManual() {
    setFormError(null);
    if (vehicleId === '') {
      setFormError('Pick a vehicle.');
      return;
    }
    let ppl: number;
    let lit: number;
    let odo: number;
    try {
      odo = parseInt(odometerKm, 10);
      if (!Number.isFinite(odo) || odo < 0) throw new Error('Odometer must be a non-negative integer');
      ppl = num(pricePerLiter, 'Price/L');
      lit = num(liters, 'Amount');
    } catch (err) {
      setFormError((err as Error).message);
      return;
    }
    // Pre-fill the total from price/L × amount; editable on the confirmation step.
    setTotalPrice(String(+(lit * ppl).toFixed(2)));
    setStep(2);
  }

  async function submit(e: React.FormEvent, allowRegression = false) {
    e.preventDefault();
    setFormError(null);

    if (vehicleId === '') {
      setFormError('Pick a vehicle.');
      return;
    }
    let ppl: number;
    let lit: number;
    let tot: number;
    let odo: number;
    try {
      lit = num(liters, 'Liters');
      tot = num(totalPrice, 'Total price');
      ppl = pricePerLiter.trim() === '' ? +(tot / lit).toFixed(3) : num(pricePerLiter, 'Price/L');
      odo = parseInt(odometerKm, 10);
      if (!Number.isFinite(odo) || odo < 0) throw new Error('Odometer must be a non-negative integer');
    } catch (err) {
      setFormError((err as Error).message);
      return;
    }

    setSaving(true);
    try {
      const result = await api.fuelings.create({
        vehicle_id: vehicleId,
        fueled_at: fueledAt,
        odometer_km: odo,
        liters: lit,
        total_price: tot,
        price_per_liter: ppl,
        currency: currency.toUpperCase(),
        fuel_type: fuelType,
        fill_status: fillStatus,
        latitude: coords?.latitude ?? null,
        longitude: coords?.longitude ?? null,
        station_name: null,
        country_code: countryCode,
        notes: notes.trim() || null,
        allow_odometer_regression: allowRegression || undefined,
      });
      if (result.warnings && result.warnings.length > 0) {
        // Non-blocking warnings: show but proceed.
        console.warn('fueling warnings', result.warnings);
      }
      nav('/');
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('odometer_regression') && !allowRegression) {
        if (confirm('Odometer is lower than a previous reading. Save anyway?')) {
          await submit(e, true);
          return;
        }
      }
      setFormError(msg);
    } finally {
      setSaving(false);
    }
  }

  if (step === 1) {
    return (
      <div className="space-y-4 pb-8">
        <div className="grid grid-cols-2 gap-1 rounded-lg bg-slate-900 p-1">
          <button
            type="button"
            onClick={() => setEntryMode('photo')}
            className={
              entryMode === 'photo'
                ? 'rounded-md bg-slate-700 py-3 text-base font-medium text-slate-100'
                : 'rounded-md py-3 text-base text-slate-400'
            }
          >
            📷 Photo
          </button>
          <button
            type="button"
            onClick={() => setEntryMode('manual')}
            className={
              entryMode === 'manual'
                ? 'rounded-md bg-slate-700 py-3 text-base font-medium text-slate-100'
                : 'rounded-md py-3 text-base text-slate-400'
            }
          >
            ✏️ Manual
          </button>
        </div>

        {entryMode === 'photo' ? (
          <section className="space-y-3">
            <PhotoButton
              label="Pump display"
              captured={pump !== null}
              mode={pumpMode}
              onOpen={() => setPumpMode('camera')}
              onCancel={() => setPumpMode('idle')}
              onCapture={(f) => captureShot(f, 'pump')}
            />
            <PhotoButton
              label="Dashboard / odometer"
              captured={dash !== null}
              mode={dashMode}
              onOpen={() => setDashMode('camera')}
              onCancel={() => setDashMode('idle')}
              onCapture={(f) => captureShot(f, 'dash')}
            />
            {ocrError && <p className="text-sm text-rose-400">OCR: {ocrError}</p>}
            {formError && <p className="text-sm text-rose-400">{formError}</p>}
            <button
              type="button"
              onClick={() => void nextFromPhoto()}
              disabled={ocrBusy || (!pump && !dash)}
              className="btn-primary w-full disabled:opacity-50"
            >
              {ocrBusy ? 'Reading…' : 'Scan & continue'}
            </button>
          </section>
        ) : (
          <section className="space-y-3">
            <div>
              <label className="label">Vehicle</label>
              <VehiclePicker vehicles={vehicles} value={vehicleId} onChange={setVehicleId} />
            </div>
            <div>
              <label className="label">Odometer (km)</label>
              <input
                className="input"
                type="number"
                inputMode="numeric"
                step="1"
                value={odometerKm}
                onChange={(e) => setOdometerKm(e.target.value)}
                required
              />
            </div>
            <div>
              <label className="label">Price / L</label>
              <input
                className="input"
                type="number"
                inputMode="decimal"
                step="0.001"
                value={pricePerLiter}
                onChange={(e) => setPricePerLiter(e.target.value)}
                required
              />
            </div>
            <div>
              <label className="label">Amount (L)</label>
              <input
                className="input"
                type="number"
                inputMode="decimal"
                step="0.01"
                value={liters}
                onChange={(e) => setLiters(e.target.value)}
                required
              />
            </div>
            {formError && <p className="text-sm text-rose-400">{formError}</p>}
            <button type="button" onClick={nextFromManual} className="btn-primary w-full">
              Continue
            </button>
          </section>
        )}
      </div>
    );
  }

  return (
    <form onSubmit={(e) => submit(e)} className="space-y-4 pb-8">
      <button
        type="button"
        onClick={() => setStep(1)}
        className="text-xs font-medium text-emerald-400"
      >
        ← Back
      </button>

      <section className="space-y-2">
        <div>
          <label className="label">Vehicle</label>
          <VehiclePicker vehicles={vehicles} value={vehicleId} onChange={setVehicleId} />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="label">Liters</label>
            <input
              className="input"
              type="number"
              inputMode="decimal"
              step="0.01"
              value={liters}
              onChange={(e) => setLiters(e.target.value)}
              required
            />
          </div>
          <div>
            <label className="label">Total ({currency})</label>
            <input
              className="input"
              type="number"
              inputMode="decimal"
              step="0.01"
              value={totalPrice}
              onChange={(e) => setTotalPrice(e.target.value)}
              required
            />
          </div>
          <div>
            <label className="label">Price / L</label>
            <input
              className="input"
              type="number"
              inputMode="decimal"
              step="0.001"
              value={pricePerLiter}
              onChange={(e) => setPricePerLiter(e.target.value)}
              placeholder="auto"
            />
          </div>
          <div>
            <label className="label">Currency</label>
            <input
              className="input"
              value={currency}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())}
              maxLength={3}
              required
            />
          </div>
          <div>
            <label className="label">Odometer (km)</label>
            <input
              className="input"
              type="number"
              inputMode="numeric"
              step="1"
              value={odometerKm}
              onChange={(e) => setOdometerKm(e.target.value)}
              required
            />
          </div>
          <div>
            <label className="label">Fuel type</label>
            <select
              className="input"
              value={fuelType}
              onChange={(e) => setFuelType(e.target.value as FuelType)}
            >
              {FUEL_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Fill</label>
            <select
              className="input"
              value={fillStatus}
              onChange={(e) => setFillStatus(e.target.value as FillStatus)}
            >
              <option value="full">Full</option>
              <option value="partial">Partial</option>
              <option value="unknown">Unknown</option>
            </select>
          </div>
          <div>
            <label className="label">Date</label>
            <input
              className="input"
              type="date"
              value={fueledAt}
              onChange={(e) => setFueledAt(e.target.value)}
              required
            />
          </div>
        </div>

        <div>
          <label className="label">Notes (optional)</label>
          <textarea
            className="input"
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>

        {autoVehicleHint && (
          <p className="text-xs text-slate-400">
            Detected: <span className="text-slate-200">{autoVehicleHint.kind}</span>{' '}
            (confidence {autoVehicleHint.confidence})
          </p>
        )}
        {crossCheck && <CrossCheckBanner cc={crossCheck} />}
        {ocrDebug && <OcrDebugPanel debug={ocrDebug} />}

        {coords && (
          <p className="text-xs text-slate-500">
            📍 {coords.latitude.toFixed(4)}, {coords.longitude.toFixed(4)}
            {countryCode ? ` · ${countryCode}` : ''} · default {defaultCurrency}
          </p>
        )}
      </section>

      {formError && <p className="text-sm text-rose-400">{formError}</p>}

      <button type="submit" disabled={saving} className="btn-primary w-full">
        {saving ? 'Saving…' : 'Save fueling'}
      </button>
    </form>
  );
}

function VehiclePicker({
  vehicles,
  value,
  onChange,
}: {
  vehicles: Vehicle[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <div role="radiogroup" className="grid grid-cols-2 gap-2">
      {vehicles.map((v) => {
        const selected = v.id === value;
        return (
          <button
            key={v.id}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(v.id)}
            className={
              selected
                ? 'flex min-h-16 flex-col items-start justify-center rounded-lg border-2 border-emerald-500 bg-emerald-950/30 px-3 py-3 text-left'
                : 'flex min-h-16 flex-col items-start justify-center rounded-lg border-2 border-slate-700 bg-slate-900 px-3 py-3 text-left'
            }
          >
            <span className="font-medium text-slate-100">{v.name}</span>
            <span className="text-xs capitalize text-slate-400">{v.kind}</span>
          </button>
        );
      })}
    </div>
  );
}

function PhotoButton({
  label,
  captured,
  mode,
  onOpen,
  onCancel,
  onCapture,
}: {
  label: string;
  captured: boolean;
  mode: CaptureMode;
  onOpen: () => void;
  onCancel: () => void;
  onCapture: (file: File) => void;
}) {
  if (mode === 'camera') {
    return (
      <div>
        <label className="label">{label}</label>
        <InAppCamera onCapture={onCapture} onCancel={onCancel} />
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      className={
        captured
          ? 'flex h-28 w-full items-center justify-center gap-2 rounded-lg border border-emerald-700 bg-emerald-950/30 text-base font-medium text-emerald-300'
          : 'flex h-28 w-full items-center justify-center gap-2 rounded-lg border-2 border-dashed border-slate-700 text-base text-slate-300'
      }
    >
      {captured ? `✓ ${label} · tap to retake` : `📷 ${label}`}
    </button>
  );
}

function CrossCheckBanner({ cc }: { cc: OcrCrossCheck }) {
  if (cc.status === 'ok') {
    return <p className="text-xs text-emerald-400">✓ Pump arithmetic checks out (liters × price/L ≈ total).</p>;
  }
  if (cc.status === 'derived' && cc.derived_field) {
    const labels: Record<NonNullable<OcrCrossCheck['derived_field']>, string> = {
      liters: 'Liters',
      total_price: 'Total',
      price_per_liter: 'Price/L',
    };
    return (
      <p className="text-xs text-sky-400">
        ℹ <strong>{labels[cc.derived_field]}</strong> filled in from the other two values.
      </p>
    );
  }
  if (cc.status === 'mismatch') {
    return (
      <p className="text-xs text-amber-400">
        ⚠ OCR values don't add up: {cc.message ?? 'discrepancy detected'} Please verify before saving.
      </p>
    );
  }
  return null;
}

function OcrDebugPanel({
  debug,
}: {
  debug: {
    model?: string;
    prompt_version?: string;
    raw_pump_response?: string | null;
    raw_dashboard_response?: string | null;
  };
}) {
  return (
    <details className="rounded-lg border border-slate-800 bg-slate-900/50 p-2 text-xs">
      <summary className="cursor-pointer text-slate-400">
        AI prompt response (debug)
        {debug.model ? <span className="text-slate-500"> · {debug.model}</span> : null}
        {debug.prompt_version ? <span className="text-slate-500"> · {debug.prompt_version}</span> : null}
      </summary>
      <div className="mt-2 space-y-2">
        <div>
          <div className="text-slate-500">pump:</div>
          <pre className="overflow-x-auto whitespace-pre-wrap break-words text-slate-300">
            {debug.raw_pump_response ?? '(none)'}
          </pre>
        </div>
        <div>
          <div className="text-slate-500">dashboard:</div>
          <pre className="overflow-x-auto whitespace-pre-wrap break-words text-slate-300">
            {debug.raw_dashboard_response ?? '(none)'}
          </pre>
        </div>
      </div>
    </details>
  );
}
