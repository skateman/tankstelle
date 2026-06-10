import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Vehicle, type VehicleStats } from '../lib/api';
import { formatFueledAt, formatMoney } from '../lib/format';

type VehicleWithStats = {
  vehicle: Vehicle;
  stats: VehicleStats;
};

export default function VehiclesHome() {
  const [items, setItems] = useState<VehicleWithStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);

    api.vehicles
      .list()
      .then(async (vehicles) => {
        const nextItems = await Promise.all(
          vehicles.map(async (vehicle) => ({
            vehicle,
            stats: await api.vehicles.stats(vehicle.id),
          })),
        );
        if (!active) return;
        setItems(nextItems);
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
  }, []);

  if (loading) return <p className="text-slate-400">Loading…</p>;
  if (error) return <p className="text-rose-400">Error: {error}</p>;

  if (items.length === 0) {
    return (
      <div className="mt-16 text-center text-slate-400">
        <p>No vehicles yet.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4 pb-8">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
        Vehicles
      </h2>

      <div className="space-y-3">
        {items.map(({ vehicle, stats }) => (
          <Link
            key={vehicle.id}
            to={`/vehicles/${vehicle.id}`}
            className="block rounded-lg border border-slate-800 bg-slate-900 p-4 active:border-emerald-500"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-semibold text-slate-100">{vehicle.name}</div>
                <div className="text-xs capitalize text-slate-400">{vehicle.kind}</div>
              </div>
              <span className="text-xl" aria-hidden="true">
                {vehicle.kind === 'motorbike' ? '🏍️' : '🚗'}
              </span>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
              <Stat
                label="Odometer"
                value={
                  stats.latest_odometer_km == null
                    ? '—'
                    : `${stats.latest_odometer_km.toLocaleString()} km`
                }
              />
              <Stat label="Fuelings" value={stats.fueling_count.toLocaleString()} />
              <Stat label="Liters" value={`${stats.total_liters.toFixed(2)} L`} />
              <Stat
                label="Last fueled"
                value={stats.last_fueled_at ? formatFueledAt(stats.last_fueled_at) : '—'}
              />
            </div>

            <div className="mt-3 border-t border-slate-800 pt-3 text-xs text-slate-500">
              <div>{formatSpend(stats.total_spend)}</div>
              <div className="mt-1">
                Avg consumption:{' '}
                <span className="text-slate-300">
                  {stats.avg_consumption_l_per_100km == null
                    ? '—'
                    : `${stats.avg_consumption_l_per_100km.toFixed(2)} L/100 km`}
                </span>
              </div>
            </div>
          </Link>
        ))}
      </div>

      <Link to="/new" className="btn-primary block w-full text-center">
        ➕ Add new fueling
      </Link>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-slate-100">{value}</div>
    </div>
  );
}

function formatSpend(totalSpend: Record<string, number>): string {
  const entries = Object.entries(totalSpend).filter(([, amount]) => amount > 0);
  if (entries.length === 0) return 'Total spend: —';
  return `Total spend: ${entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, amount]) => formatMoney(amount, currency))
    .join(' · ')}`;
}
