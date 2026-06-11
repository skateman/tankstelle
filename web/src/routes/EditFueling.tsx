import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  api,
  FUEL_TYPES,
  type FillStatus,
  type Fueling,
  type FuelType,
  type Vehicle,
} from '../lib/api';

export default function EditFueling() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();

  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [vehicleId, setVehicleId] = useState<string>('');
  const [fueledAt, setFueledAt] = useState<string>('');
  const [odometerKm, setOdometerKm] = useState<string>('');
  const [liters, setLiters] = useState<string>('');
  const [totalPrice, setTotalPrice] = useState<string>('');
  const [pricePerLiter, setPricePerLiter] = useState<string>('');
  const [currency, setCurrency] = useState<string>('EUR');
  const [fuelType, setFuelType] = useState<FuelType>('diesel');
  const [fillStatus, setFillStatus] = useState<FillStatus>('full');
  const [notes, setNotes] = useState<string>('');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let active = true;
    setLoading(true);
    setError(null);

    api.fuelings
      .get(id)
      .then(async (f: Fueling) => {
        if (!active) return;
        setVehicleId(f.vehicle_id);
        setFueledAt(f.fueled_at.slice(0, 10));
        setOdometerKm(String(f.odometer_km));
        setLiters(String(f.liters));
        setTotalPrice(String(f.total_price));
        setPricePerLiter(String(f.price_per_liter));
        setCurrency(f.currency);
        setFuelType(f.fuel_type);
        setFillStatus(f.fill_status);
        setNotes(f.notes ?? '');
        try {
          const vehicles = await api.vehicles.list();
          if (active) setVehicle(vehicles.find((v) => v.id === f.vehicle_id) ?? null);
        } catch {
          // vehicle name is cosmetic
        }
      })
      .catch((e: Error) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [id]);

  async function save(e: React.FormEvent, allowRegression = false) {
    e.preventDefault();
    if (!id) return;
    setFormError(null);

    const num = (s: string, name: string) => {
      // Accept a comma decimal separator (some mobile decimal keypads insert ',').
      const n = Number(s.replace(',', '.').trim());
      if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`);
      return n;
    };
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
      await api.fuelings.update(id, {
        fueled_at: fueledAt,
        odometer_km: odo,
        liters: lit,
        total_price: tot,
        price_per_liter: ppl,
        currency: currency.toUpperCase(),
        fuel_type: fuelType,
        fill_status: fillStatus,
        notes: notes.trim() || null,
        allow_odometer_regression: allowRegression || undefined,
      });
      nav(`/vehicles/${vehicleId}`);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('odometer_regression') && !allowRegression) {
        if (confirm('Odometer is lower than a previous reading. Save anyway?')) {
          await save(e, true);
          return;
        }
      }
      setFormError(msg);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!id) return;
    if (!confirm('Delete this fueling? This cannot be undone.')) return;
    setDeleting(true);
    setFormError(null);
    try {
      await api.fuelings.remove(id);
      nav(`/vehicles/${vehicleId}`);
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setDeleting(false);
    }
  }

  if (loading) return <p className="text-slate-400">Loading…</p>;
  if (error) return <p className="text-rose-400">Error: {error}</p>;

  return (
    <form onSubmit={(e) => save(e)} className="space-y-4 pb-8">
      <div className="space-y-1">
        <Link to={`/vehicles/${vehicleId}`} className="text-xs font-medium text-emerald-400">
          ← Back
        </Link>
        <h2 className="text-lg font-semibold text-slate-100">Edit fueling</h2>
        {vehicle && <p className="text-xs capitalize text-slate-400">{vehicle.name} · {vehicle.kind}</p>}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="label">Liters</label>
          <input
            className="input"
            type="text"
            inputMode="decimal"
            value={liters}
            onChange={(e) => setLiters(e.target.value)}
            required
          />
        </div>
        <div>
          <label className="label">Total ({currency})</label>
          <input
            className="input"
            type="text"
            inputMode="decimal"
            value={totalPrice}
            onChange={(e) => setTotalPrice(e.target.value)}
            required
          />
        </div>
        <div>
          <label className="label">Price / L</label>
          <input
            className="input"
            type="text"
            inputMode="decimal"
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
            type="text"
            inputMode="numeric"
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

      {formError && <p className="text-sm text-rose-400">{formError}</p>}

      <div className="flex gap-2">
        <button type="submit" disabled={saving || deleting} className="btn-primary flex-1">
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={() => void remove()}
          disabled={saving || deleting}
          className="btn-ghost text-rose-400"
        >
          {deleting ? 'Deleting…' : 'Delete'}
        </button>
      </div>
    </form>
  );
}
