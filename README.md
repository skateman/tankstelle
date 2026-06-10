# Tankstelle

Personal PWA to track car + motorbike fuelings using a phone camera pointed at pump displays and odometers.

## Stack

- **Frontend** (`web/`) — Vite + React + TypeScript, Tailwind, PWA via `vite-plugin-pwa`.
- **Backend** (`server/`) — Hono + Node + TypeScript, **Azure Table Storage** via `@azure/data-tables` (Azurite locally, real Storage account in prod).
- **OCR** — Azure OpenAI vision (any deployment that supports image input).
- **Geocoding** — OpenStreetMap Nominatim, server-side proxy with caching + 1 req/s rate limit.

## Prerequisites

- Node 20+ (developed against 24.x)
- An Azure OpenAI resource with a vision-capable deployment

## Setup

```bash
cp .env.example .env       # then fill in AZURE_OPENAI_* values
npm install
npm run dev                # starts Azurite (10000-2) + backend (8787) + frontend (5173)
```

Open <http://localhost:5173>.

Local dev runs against [Azurite](https://learn.microsoft.com/azure/storage/common/storage-use-azurite), the Azure Storage emulator. Data lives in `server/.azurite/` (gitignored). To wipe and start fresh, stop the dev server and `rm -rf server/.azurite/`. For production, set `AZURE_STORAGE_CONNECTION_STRING` to a real Storage account's connection string and tables will be created on first use.

## Scripts

| Command          | What it does                                         |
|------------------|------------------------------------------------------|
| `npm run dev`    | Run Azurite + server + web with hot reload           |
| `npm run build`  | Type-check + build server (`tsc`) + web (`vite`)     |
| `npm run typecheck` | Type-check both workspaces                        |
| `npm start`      | Run the compiled server                              |
| `npm run -w server azurite` | Run Azurite alone (the `dev` script already does this) |
| `npm run -w server import:motomoshi -- <csv> ...` | Import a Motomoshi-format CSV (also produced by `carspending.com` "Export") into Table Storage |

## Environment

See `.env.example`. Required for OCR: `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`. Default deployment is `gpt-5.4-nano`; override via `AZURE_OPENAI_DEPLOYMENT`. The server runs without these but `/api/ocr/pump` will return null fields and the app falls back to manual entry.

### Storage auth modes

The server auto-selects between two storage auth modes based on which env vars are set:

| Mode | When used | Required env |
|------|-----------|--------------|
| **Connection string** | Local dev (Azurite), single-account scenarios | `AZURE_STORAGE_CONNECTION_STRING` *(or `AzureWebJobsStorage`)* |
| **Managed Identity** | Production inside Azure Functions / App Service | `AZURE_STORAGE_TABLE_URI` *(or `AzureWebJobsStorage__tableServiceUri`)*. Optionally `AZURE_CLIENT_ID` for a user-assigned MI. The identity needs the **Storage Table Data Contributor** role on the account. |

If neither is set, defaults to Azurite (`UseDevelopmentStorage=true`). The Functions-runtime variant names are accepted so tankstelle can drop into nexus's existing Function App and reuse the same Storage account that `tankarta` writes to — no extra config.

### Secrets in production

Don't put `AZURE_OPENAI_API_KEY` in plain App Settings. Set the App Setting value to a Key Vault reference:

```
AZURE_OPENAI_API_KEY = @Microsoft.KeyVault(SecretUri=https://<vault>.vault.azure.net/secrets/<name>/)
```

The Functions runtime resolves the reference at startup and exposes the resolved value to `process.env`, so the code in this repo reads it normally. The Function App's identity needs the **Key Vault Secrets User** role on the vault.

## Security notes

**Local dev runs open** (no auth) and binds to `127.0.0.1`. Set `HOST=0.0.0.0` to reach it from your phone over LAN (a warning is logged).

**Production requires Microsoft Entra ID sign-in.** Token validation is done by the Azure App Service Authentication (**"Easy Auth"**) platform layer in front of the Function App: every `/api/*` route (except `/api/health`) is rejected with **401 before the function executes** unless the caller presents a valid Bearer access token from your tenant for the SPA app registration — so anonymous floods never run your code or spend on OpenAI. On top of that platform check, the Hono app authorizes the request from the injected `x-ms-client-principal` header: it requires the `access_as_user` scope and that the `oid` claim matches `OWNER_OID`, locking the API (including `/api/ocr/pump`) to you alone. The PWA signs in via MSAL and sends the token. App-level authz is enforced **only** when `OWNER_OID` is set, so it never gets in the way locally. See [Auth](#auth-microsoft-entra-id).

## Auth (Microsoft Entra ID)

A **shared** single-tenant SPA app registration (created by `azure-iac/app-registration.bicep`) backs the PWA sign-in and the API's exposed scope (`access_as_user`). The same registration is reused across all apps on the platform.

**Token validation** is handled by **Azure App Service Authentication ("Easy Auth")** configured on the `fn-nexus` Function App (see `azure-iac/modules/fn-nexus/main.bicep`): it validates the Bearer token's signature, issuer (v2), and audience (the SPA client id) at the platform layer and rejects unauthenticated callers with 401 **before** the function runs — `/api/tankstelle/health` is excluded so probes still work. The server does not validate tokens itself, so any non-local deployment **must** sit behind Easy Auth (or a proxy that injects a trusted `x-ms-client-principal` header).

**Backend authorization** (`server/`): the only setting the app needs is `OWNER_OID`
(your user object id), set as an App Setting (Key Vault reference) by azure-iac. It is
compared against the `oid` claim in the Easy Auth `x-ms-client-principal` header, and the
`access_as_user` scope is required. Unset ⇒ app-level authz disabled (dev). `CORS_ALLOWED_ORIGINS`
(comma-separated) restricts browser origins; unset ⇒ any origin (the platform still gates).

**Frontend** (`web/`): set as Vite build env —
`VITE_ENTRA_TENANT_ID`, `VITE_ENTRA_CLIENT_ID`, `VITE_API_SCOPE`
(e.g. `api://spa/access_as_user`), optional `VITE_REDIRECT_URI` (defaults to the page
origin), and optional `VITE_API_BASE` (the external base that the local `/api` maps to when
the PWA and API are on different hosts — e.g. `https://fn-nexus.azurewebsites.net/api/tankstelle`
for a Static Web App calling the nexus-hosted backend; defaults to relative `/api` for local dev).
Auth vars unset ⇒ the PWA talks to the open dev API.

In production these are set in the **`Deploy PWA` workflow** (`.github/workflows/deploy-web.yml`),
which builds `web/` and pushes it to the Azure Static Web App. The `VITE_*` values and the SWA
deploy token (`AZURE_STATIC_WEB_APPS_API_TOKEN`, copied from the `swa-tankstelle-token` Key Vault
secret that azure-iac creates) are all repository **secrets**.

One-time setup: deploy the shared app registration manually (you, not CI — it needs Graph
app-management rights), then store its `clientId` as the `spa-client-id` Key Vault secret
(azure-iac reads it at deploy time to configure Easy Auth's allowed audience on fn-nexus) and
set it as `VITE_ENTRA_CLIENT_ID` in the PWA build. Also store your user object id as the
`owner-oid` Key Vault secret (fn-nexus exposes it as `OWNER_OID` via its `secretNames` loop).

## Deploying inside nexus (Azure Functions)

The server is published as the public npm package **`@skateman/tankstelle`** and
embedded into the personal [`nexus`](https://github.com/skateman/nexus) Function App,
with infrastructure in [`azure-iac`](https://github.com/skateman/azure-iac). The PWA is
hosted on its own Static Web App (free tier) and calls the fn-nexus API cross-origin with a
Bearer token (CORS restricted to the SPA origins). One shared app registration and one
fn-nexus back every app on the platform; each app lives under `/api/<app>/*`. Split of
responsibilities:

| Repo | Owns |
|------|------|
| **tankstelle** (here) | The PWA (`web/`, MSAL sign-in) and the portable API library (`server/`, Entra owner authorization). `server/src/lib.ts` exports `createApp()`, a Web-standard Hono app driven via `app.fetch(request)`. Token validation is delegated to the host's Easy Auth layer. |
| **nexus** | A ~50-line HTTP function (`src/functions/tankstelle.js`) that lazy-imports `createApp()` and bridges Azure Functions ⇄ `fetch`. Mounts the app under its own `/api/tankstelle/*` parent route (strips the prefix before handing off, so the library keeps its `/api/*` contract). |
| **azure-iac** | The app registration (`app-registration.bicep`, deployed manually), plus App Settings + RBAC: storage via managed identity, Azure OpenAI endpoint/deployment, the key as a Key Vault reference (`oai-key`), the `OWNER_OID` authorization setting, and the **Easy Auth** (`authSettingsV2`) platform config that validates tokens in front of the Function App. |

In production the server selects **Managed Identity** storage auth automatically (it
reads `AzureWebJobsStorage__tableServiceUri` + `AZURE_CLIENT_ID`), so no code change is
needed between local dev and the cloud — see [Storage auth modes](#storage-auth-modes).

### Publishing a new version

```bash
npm version patch -w server     # bump server/package.json
git commit -am "server: vX.Y.Z" && git tag vX.Y.Z && git push --tags
```

The `Publish server package` workflow builds and publishes to the public npm registry on
the tag using **npm Trusted Publishing (OIDC)** — no `NPM_TOKEN` secret. Then bump the
version in nexus's `package.json` and redeploy nexus.

#### One-time bootstrap

A Trusted Publisher can only be configured on a package that already exists, so the very
first publish is manual:

```bash
# from a throwaway dir — reserves the name with an empty stub
mkdir /tmp/tankstelle-stub && cd /tmp/tankstelle-stub
npm init -y --scope=@skateman
npm pkg set name='@skateman/tankstelle' version='0.0.0'
echo "Placeholder — see https://github.com/skateman/tankstelle" > README.md
npm login                         # interactive, one time
npm publish --access public
```

Then on npmjs.com → the package → **Settings → Trusted Publisher**, add a GitHub Actions
publisher:

- Organization/owner: `skateman`
- Repository: `tankstelle`
- Workflow filename: `publish.yml`
- Environment: *(leave blank unless you add one to the workflow)*

After that, every `v*` tag publishes via OIDC with zero stored credentials. (The
`@skateman` scope must belong to your npm account; if your npm username differs, switch
the package to an unscoped name like `tankstelle`.)

## iPhone "Add to Home Screen"

The web app is a PWA with iOS meta tags, `apple-touch-icon`, safe-area padding, and `viewport-fit=cover`. In Safari, tap Share → Add to Home Screen.

**Camera capture without polluting Photos:** the New Fueling form opens an in-app camera (via `getUserMedia`) and grabs a frame to memory — the photo never touches your Photos library. This requires a **secure context (HTTPS)**, which Safari grants on `localhost` but not on plain-HTTP LAN URLs. On the phone, until you front the app with an HTTPS endpoint (Tailscale Serve, Cloudflare Tunnel, ngrok, mkcert + a reverse proxy, etc.), the camera button will show a clear error and the "Upload from Photos" fallback link still works.

## Data model

Three Azure Table Storage tables (auto-created on first use):

| Table         | PartitionKey   | RowKey                       | Notes |
|---------------|----------------|------------------------------|-------|
| `vehicles`    | `"v"` (constant) | ULID                       | All vehicles in one partition (handful of rows). |
| `fuelings`    | `vehicle_id` (ULID) | `<reverseDate>_<reverseOdo>_<ulid>` | Sorts newest-first by date, then by odometer (the reliable tiebreaker for same-day fills). |
| `ocrAttempts` | `YYYYMMDD` (UTC) | `<reverse-ts>_<ulid>`     | Day-bucketed for easy retention/cleanup. |

IDs in the API are **strings (ULIDs)**, not auto-increment integers.

## API

- `GET    /api/health`
- `GET    /api/vehicles`, `POST /api/vehicles`, `PATCH /api/vehicles/:id`, `DELETE /api/vehicles/:id` (add `?cascade=true` to delete the vehicle and all its fuelings)
- `GET    /api/vehicles/:id/stats` — aggregate stats (fueling count, total liters, latest odometer, per-currency spend, avg L/100km)
- `GET    /api/fuelings?vehicle_id=&from=&to=&limit=&cursor=` — returns `{ items, next_cursor }`; pass `cursor` for the next page (cursoring is enabled when `vehicle_id` is set). Each item includes a computed `consumption_l_per_100km` (null when it can't be derived). `from`/`to` filter by `fueled_at` (date, `YYYY-MM-DD`).
- `GET    /api/fuelings/:id`
- `POST   /api/fuelings` (returns 409 `odometer_regression` if the new odometer is lower than a previous reading for the same vehicle; resubmit with `allow_odometer_regression: true` to override)
- `PATCH  /api/fuelings/:id` (cannot change `vehicle_id` — it's the PartitionKey; the same odometer-regression guard applies, and changing `fueled_at`/`odometer_km` moves the row to a new RowKey), `DELETE /api/fuelings/:id`
- `POST   /api/ocr/pump` — multipart form with `pump` and/or `dashboard` files; returns merged structured JSON
- `GET    /api/geo/lookup?lat=&lon=` — reverse-geocodes to `{country_code, currency, station_name}`

## Status / roadmap

Implemented: capture flow, OCR, manual entry & confirmation, vehicles CRUD, geo→currency, PWA install, **CSV import (Motomoshi format, carspending.com compatible)**. Planned next: charts (L/100km, cost/km), multi-currency conversion.

## Importing data from carspending.com

`carspending.com` exports each vehicle as a Motomoshi CSV via `https://carspending.com/en/vehicle/import/<id>` → "Export" (cookie-authenticated). Save the file, then:

```bash
# create a new vehicle and import all its fuelings
npm run -w server import:motomoshi -- ./motomoshi_mycar_*.csv \
  --create-vehicle --name "My Car" --kind car

# import into an existing vehicle by name (easiest)
npm run -w server import:motomoshi -- ./motomoshi_mybike_*.csv \
  --vehicle-name "My Bike"

# or by ULID
npm run -w server import:motomoshi -- ./motomoshi_mybike_*.csv \
  --vehicle-id xxxxxxxxxxxxx
```

Notes:
- Motomoshi records date only (no time). Imported rows store `fueled_at` as a date (`YYYY-MM-DD`); odometer is used as the tiebreaker when sorting same-day fills.
- Motomoshi has a single `gasoline` fuel type; map to a specific Tankstelle type with `--fuel-type {diesel|gasoline_95|gasoline_98|e10|premium|other}` (default `gasoline_95`).
- Re-running the importer is **idempotent**: duplicates are detected by `(vehicle_id, fueled_at, odometer_km, liters, total_price, currency)` and skipped.
- Use `--dry-run` to preview parse + counts without writing.
- Expenses in the CSV are listed but **not imported** (Tankstelle has no expenses table).
- Rows where Motomoshi's "Has missed" flag is `1` are imported with `fill_status='unknown'` to mark the consumption discontinuity.
