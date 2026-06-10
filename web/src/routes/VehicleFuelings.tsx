import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type Fueling, type Vehicle } from '../lib/api';
import { formatFueledAt, formatMoney } from '../lib/format';

const PAGE_SIZE = 20;

export default function VehicleFuelings() {
  const { id } = useParams<{ id: string }>();
  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [fuelings, setFuelings] = useState<Fueling[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;

    let active = true;
    setLoading(true);
    setError(null);
    setFuelings([]);
    setNextCursor(null);

    Promise.all([
      api.vehicles.list(),
      api.fuelings.list({ vehicle_id: id, limit: PAGE_SIZE }),
    ])
      .then(([vehicles, page]) => {
        if (!active) return;
        setVehicle(vehicles.find((v) => v.id === id) ?? null);
        setFuelings(page.items);
        setNextCursor(page.next_cursor);
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

  async function loadMore() {
    if (!id || !nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await api.fuelings.list({
        vehicle_id: id,
        limit: PAGE_SIZE,
        cursor: nextCursor,
      });
      setFuelings((prev) => [...prev, ...page.items]);
      setNextCursor(page.next_cursor);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingMore(false);
    }
  }

  if (loading) return <p className="text-slate-400">Loading…</p>;
  if (!id) return <p className="text-rose-400">Missing vehicle id.</p>;

  return (
    <div className="space-y-4 pb-8">
      <div className="space-y-3">
        <Link to="/" className="text-xs font-medium text-emerald-400">
          ← Home
        </Link>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-100">
              {vehicle?.name ?? 'Vehicle'}
            </h2>
            {vehicle && <p className="text-xs capitalize text-slate-400">{vehicle.kind}</p>}
          </div>
          <Link to={`/new?vehicle_id=${encodeURIComponent(id)}`} className="btn-ghost text-sm">
            ＋ Add fueling
          </Link>
        </div>
      </div>

      {error && <p className="text-sm text-rose-400">Error: {error}</p>}

      {fuelings.length === 0 && !error ? (
        <div className="mt-16 text-center text-slate-400">
          <p className="mb-4">No fuelings for this vehicle yet.</p>
          <Link to={`/new?vehicle_id=${encodeURIComponent(id)}`} className="btn-primary">
            + Add your first fueling
          </Link>
        </div>
      ) : (
        <ul className="space-y-2">
          {fuelings.map((f) => (
            <FuelingCard key={f.id} fueling={f} />
          ))}
        </ul>
      )}

      {nextCursor && (
        <button
          type="button"
          onClick={() => void loadMore()}
          disabled={loadingMore}
          className="btn-ghost w-full disabled:opacity-50"
        >
          {loadingMore ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  );
}

function FuelingCard({ fueling: f }: { fueling: Fueling }) {
  return (
    <li>
      <Link
        to={`/fuelings/${encodeURIComponent(f.id)}/edit`}
        className="block rounded-lg border border-slate-800 bg-slate-900 p-3 transition-colors hover:border-slate-700 hover:bg-slate-800/60"
      >
        <div className="flex items-baseline justify-between gap-3">
          <span className="font-medium text-slate-100">{formatFueledAt(f.fueled_at)}</span>
          <span className="text-xs text-slate-400">{f.odometer_km.toLocaleString()} km</span>
        </div>
        <div className="mt-1 grid grid-cols-3 gap-2 text-sm">
          <Stat label="Liters" value={f.liters.toFixed(2)} />
          <Stat label="Total" value={formatMoney(f.total_price, f.currency)} />
          <Stat label="Consumption" value={formatConsumption(f.consumption_l_per_100km)} />
        </div>
        <div className="mt-1 text-xs text-slate-500">
          {formatMoney(f.price_per_liter, f.currency)}/L · {f.fuel_type} · {f.fill_status}
          {f.station_name ? ` · ${f.station_name}` : ''}
        </div>
      </Link>
    </li>
  );
}

function formatConsumption(value: number | null | undefined): string {
  if (value == null) return '—';
  return `${value.toFixed(2)} L/100km`;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-slate-100">{value}</div>
    </div>
  );
}
