export type Vehicle = {
  id: string;
  name: string;
  kind: 'car' | 'motorbike';
  default_fuel_type: FuelType | null;
  notes: string | null;
  created_at: string;
};

export type FuelType =
  | 'diesel'
  | 'gasoline_95'
  | 'gasoline_98'
  | 'e10'
  | 'premium'
  | 'other';

export const FUEL_TYPES: { value: FuelType; label: string }[] = [
  { value: 'diesel', label: 'Diesel' },
  { value: 'gasoline_95', label: 'Gasoline 95' },
  { value: 'gasoline_98', label: 'Gasoline 98' },
  { value: 'e10', label: 'E10' },
  { value: 'premium', label: 'Premium' },
  { value: 'other', label: 'Other' },
];

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
  created_at: string;
  consumption_l_per_100km?: number | null;
};

export type FuelingsPage = {
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

export type FuelingInput = Omit<Fueling, 'id' | 'created_at'> & {
  allow_odometer_regression?: boolean;
};

export type OcrPump = {
  liters: number | null;
  total_price: number | null;
  price_per_liter: number | null;
  currency_hint: string | null;
  fuel_type: FuelType | null;
  confidence: 'high' | 'medium' | 'low';
};

export type OcrDashboard = {
  odometer_km: number | null;
  kind: 'car' | 'motorbike' | 'unknown';
  confidence: 'high' | 'medium' | 'low';
};

export type OcrCrossCheck = {
  status: 'ok' | 'derived' | 'mismatch' | 'insufficient';
  derived_field?: 'liters' | 'total_price' | 'price_per_liter';
  message?: string;
  relative_error?: number;
};

export type OcrResponse = {
  pump: OcrPump | null;
  pump_cross_check: OcrCrossCheck | null;
  dashboard: OcrDashboard | null;
  model?: string;
  prompt_version?: string;
  raw_pump_response?: string | null;
  raw_dashboard_response?: string | null;
  error: string | null;
};

export type GeoLookup = {
  country_code: string | null;
  currency: string;
  station_name: string | null;
  error?: string;
};

import { getToken, isAuthEnabled } from './auth';

// External base that the app's local "/api" maps to. For cross-origin hosting
// (e.g. SWA → fn-nexus where the app lives at /api/tankstelle/*) set this to the
// full external base, e.g. "https://fn-nexus.azurewebsites.net/api/tankstelle".
// Unset ⇒ same-origin "/api" (local dev / Vite proxy).
const API_BASE = ((import.meta.env.VITE_API_BASE as string | undefined) ?? '').replace(/\/$/, '');

function resolveUrl(url: string): string {
  if (API_BASE && url.startsWith('/api')) return url.replace(/^\/api/, API_BASE);
  return url;
}

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (isAuthEnabled) {
    const token = await getToken();
    if (token) headers.set('Authorization', `Bearer ${token}`);
  }
  const res = await fetch(resolveUrl(url), { ...init, headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export type Health = {
  ok: boolean;
  ocr_configured: boolean;
  ocr_key_unresolved?: boolean;
  auth_configured?: boolean;
  model: string;
  storage?: string;
};

export const api = {
  health: () => jsonFetch<Health>('/api/health'),
  vehicles: {
    list: () => jsonFetch<Vehicle[]>('/api/vehicles'),
    stats: (id: string) => jsonFetch<VehicleStats>(`/api/vehicles/${id}/stats`),
    create: (v: Omit<Vehicle, 'id' | 'created_at'>) =>
      jsonFetch<Vehicle>('/api/vehicles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(v),
      }),
  },
  fuelings: {
    list: (params: { vehicle_id?: string; limit?: number; cursor?: string } = {}) => {
      const q = new URLSearchParams();
      if (params.vehicle_id) q.set('vehicle_id', params.vehicle_id);
      if (params.limit) q.set('limit', String(params.limit));
      if (params.cursor) q.set('cursor', params.cursor);
      const qs = q.toString();
      return jsonFetch<FuelingsPage>(`/api/fuelings${qs ? `?${qs}` : ''}`);
    },
    get: (id: string) => jsonFetch<Fueling>(`/api/fuelings/${id}`),
    create: (f: FuelingInput) =>
      jsonFetch<Fueling & { warnings?: string[] }>('/api/fuelings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(f),
      }),
    update: (id: string, patch: Partial<FuelingInput>) =>
      jsonFetch<Fueling>(`/api/fuelings/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      }),
    remove: (id: string) =>
      jsonFetch<void>(`/api/fuelings/${id}`, { method: 'DELETE' }),
  },
  ocr: {
    pump: (pump: File | null, dashboard: File | null) => {
      const fd = new FormData();
      if (pump) fd.append('pump', pump);
      if (dashboard) fd.append('dashboard', dashboard);
      return jsonFetch<OcrResponse>('/api/ocr/pump', { method: 'POST', body: fd });
    },
  },
  geo: {
    lookup: (lat: number, lon: number) =>
      jsonFetch<GeoLookup>(`/api/geo/lookup?lat=${lat}&lon=${lon}`),
  },
};
