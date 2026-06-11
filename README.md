# Tankstelle

Personal PWA to track car + motorbike fuelings by pointing a phone camera at pump displays and odometers.

## Stack

- **Frontend** (`web/`) — Vite + React + TS, Tailwind, PWA.
- **Backend** (`server/`) — Hono + Node + TS, Azure Table Storage (Azurite locally).
- **OCR** — Azure OpenAI vision.
- **Geocoding** — OpenStreetMap Nominatim (server-side proxy, cached, 1 req/s).

## Setup

```bash
cp .env.example .env       # fill in AZURE_OPENAI_* values
npm install
npm run dev                # Azurite (10000-2) + backend (8787) + frontend (5173)
```

Open <http://localhost:5173>. Local data lives in `server/.azurite/` (gitignored); `rm -rf` it to reset.

## Scripts

| Command | Does |
|---------|------|
| `npm run dev` | Azurite + server + web, hot reload |
| `npm run build` | Type-check + build server + web |
| `npm run typecheck` | Type-check both workspaces |
| `npm start` | Run the compiled server |
| `npm run -w server import:motomoshi -- <csv> ...` | Import a Motomoshi/carspending.com CSV |

## Environment

See `.env.example`. OCR needs `AZURE_OPENAI_ENDPOINT` + `AZURE_OPENAI_API_KEY` (default deployment `gpt-5.4-nano`, override with `AZURE_OPENAI_DEPLOYMENT`). Without them `/api/ocr/pump` returns null fields and the app falls back to manual entry.

**Storage auth** is auto-selected: `AZURE_STORAGE_CONNECTION_STRING` (or `AzureWebJobsStorage`) for a connection string, else `AZURE_STORAGE_TABLE_URI` (or `AzureWebJobsStorage__tableServiceUri`, plus optional `AZURE_CLIENT_ID`) for managed identity — the identity needs **Storage Table Data Contributor**. Neither set ⇒ Azurite. Tables are created on first use.

**Secrets in prod:** set `AZURE_OPENAI_API_KEY` to a Key Vault reference (`@Microsoft.KeyVault(SecretUri=...)`); the Function App's identity needs **Key Vault Secrets User**.

## Auth

Local dev runs **open** and binds to `127.0.0.1` (`HOST=0.0.0.0` to reach it over LAN).

In production a single-tenant SPA app registration (shared across the platform, created by `azure-iac/app-registration.bicep`) backs MSAL sign-in and the `access_as_user` scope. **Azure Easy Auth** on the Function App validates the bearer token (signature, v2 issuer, SPA-client-id audience) and rejects anonymous callers with 401 before the function runs. The Hono app then authorizes from the injected `x-ms-client-principal` header: it requires the `access_as_user` scope and `oid == OWNER_OID`. App-level authz only kicks in when `OWNER_OID` is set, so it stays out of the way locally. The server does not validate tokens itself — any non-local deployment must sit behind Easy Auth.

Frontend build vars (set as repo secrets by the `Deploy PWA` workflow): `VITE_ENTRA_TENANT_ID`, `VITE_ENTRA_CLIENT_ID`, `VITE_API_SCOPE`, optional `VITE_REDIRECT_URI` (defaults to page origin), optional `VITE_API_BASE` (external API base for cross-origin hosting).

## Architecture

The server is published as **`@skateman/tankstelle`** and embedded in the [`nexus`](https://github.com/skateman/nexus) Function App; infra lives in [`azure-iac`](https://github.com/skateman/azure-iac). The PWA is its own Static Web App calling fn-nexus cross-origin with a bearer token.

| Repo | Owns |
|------|------|
| **tankstelle** (here) | PWA (`web/`) + portable API library (`server/`). `server/src/lib.ts` exports `createApp()`, a Hono app driven via `app.fetch()`. |
| **nexus** | HTTP function bridging Azure Functions ⇄ `fetch`, mounting the app under `/api/tankstelle/*`. |
| **azure-iac** | App registration, App Settings + RBAC, and Easy Auth (`authsettingsV2`) config. |

## iPhone "Add to Home Screen"

PWA with iOS meta tags and `apple-touch-icon`; in Safari tap Share → Add to Home Screen. The in-app camera (`getUserMedia`) keeps photos out of your library but needs HTTPS (Safari allows `localhost`, not plain-HTTP LAN — front it with a tunnel/reverse proxy on the phone).

## Data model

Three Azure Table Storage tables (auto-created):

| Table | PartitionKey | RowKey | Notes |
|-------|--------------|--------|-------|
| `vehicles` | `"v"` | ULID | All in one partition. |
| `fuelings` | `vehicle_id` | `<reverseDate>_<reverseOdo>_<ulid>` | Newest-first by date, odometer tiebreaker. |
| `ocrAttempts` | `YYYYMMDD` | `<reverse-ts>_<ulid>` | Day-bucketed for retention. |

## API

- `GET /api/health`
- `GET|POST /api/vehicles`, `PATCH|DELETE /api/vehicles/:id` (`?cascade=true` deletes its fuelings)
- `GET /api/vehicles/:id/stats` — count, total liters, latest odometer, per-currency spend, avg L/100km
- `GET /api/fuelings?vehicle_id=&from=&to=&limit=&cursor=` — `{ items, next_cursor }`; each item has computed `consumption_l_per_100km`
- `GET /api/fuelings/:id`
- `POST /api/fuelings` — 409 `odometer_regression` if odometer < a prior reading; override with `allow_odometer_regression: true`
- `PATCH|DELETE /api/fuelings/:id` (can't change `vehicle_id`)
- `POST /api/ocr/pump` — multipart `pump` and/or `dashboard`, returns merged JSON
- `GET /api/geo/lookup?lat=&lon=` — `{country_code, currency, station_name}`

## Importing from carspending.com

Export a vehicle as a Motomoshi CSV (`carspending.com/en/vehicle/import/<id>` → Export), then:

```bash
npm run -w server import:motomoshi -- ./motomoshi_mycar_*.csv --create-vehicle --name "My Car" --kind car
npm run -w server import:motomoshi -- ./motomoshi_mybike_*.csv --vehicle-name "My Bike"
```

- Date only (no time); odometer is the same-day sort tiebreaker.
- Map the single Motomoshi `gasoline` type via `--fuel-type` (default `gasoline_95`).
- Idempotent (dedup by vehicle/date/odometer/liters/total/currency); `--dry-run` to preview.
- Expenses are **not** imported; rows with Motomoshi's "Has missed" flag get `fill_status='unknown'`.
