import { z } from 'zod';

const schema = z.object({
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().positive().default(8787),

  // ── Storage ──────────────────────────────────────────────────────────────
  // Pick ONE of these in production; default is the Azurite emulator for dev.
  //
  // 1) Connection string (used in local dev and any non-MI scenario).
  //    Accept both canonical and Functions-runtime names.
  AZURE_STORAGE_CONNECTION_STRING: z.string().optional(),
  AzureWebJobsStorage: z.string().optional(),
  //
  // 2) Table service URI + Managed Identity (production inside an Azure Function
  //    or App Service). Match nexus's convention.
  AZURE_STORAGE_TABLE_URI: z.string().url().optional(),
  AzureWebJobsStorage__tableServiceUri: z.string().url().optional(),
  //
  // Optional: user-assigned managed identity client id. If unset, DefaultAzureCredential
  // tries the system-assigned identity (and the rest of the credential chain).
  AZURE_CLIENT_ID: z.string().optional(),

  // ── Azure OpenAI (required for OCR) ──────────────────────────────────────
  // Accept either AZURE_OPENAI_ENDPOINT or AZURE_OPENAI_API_ENDPOINT (the name
  // common in Azure SDK docs). Same for the API key.
  //
  // In production, the recommended pattern is to put the API key in Key Vault and
  // reference it from App Settings with @Microsoft.KeyVault(SecretUri=...). The runtime
  // resolves the reference and this code reads AZURE_OPENAI_API_KEY normally.
  AZURE_OPENAI_ENDPOINT: z.string().url().optional(),
  AZURE_OPENAI_API_ENDPOINT: z.string().url().optional(),
  AZURE_OPENAI_API_KEY: z.string().optional(),
  AZURE_OPENAI_KEY: z.string().optional(),
  AZURE_OPENAI_DEPLOYMENT: z.string().default('gpt-5.4-nano'),
  AZURE_OPENAI_API_VERSION: z.string().default('2024-10-21'),

  NOMINATIM_USER_AGENT: z.string().default('tankstelle/0.1 (local-dev)'),
  DEFAULT_CURRENCY: z.string().default('EUR'),

  // ── CORS ─────────────────────────────────────────────────────────────────
  // Comma-separated list of allowed browser origins (the SPA subdomains). When
  // unset, any origin is allowed (fine for local dev; in prod the token still
  // gates access).
  CORS_ALLOWED_ORIGINS: z.string().optional(),

  // ── Auth (Microsoft Entra ID) ────────────────────────────────────────────
  // Token authentication is handled by the Azure App Service Authentication
  // ("Easy Auth") platform layer in front of the app; this app only performs
  // authorization. The single setting it needs is OWNER_OID — the owner's user
  // object id — which it compares against the `oid` claim in the Easy Auth
  // `x-ms-client-principal` header. When unset (local dev), auth is disabled.
  // In production OWNER_OID arrives from Key Vault via fn-nexus's secretNames
  // loop (secret owner-oid → env var OWNER_OID). Non-secret identifier.
  OWNER_OID: z.string().optional(), // the owner's user object id

  // Fail-closed switch. When 'true', the API refuses every request with 503
  // unless auth is fully configured. Set this in any deployed environment so a
  // missing/misconfigured Entra setting can never silently expose the API.
  // Compared literally against 'true' so that the string 'false' disables it
  // (unlike z.coerce.boolean()).
  REQUIRE_AUTH: z.string().optional(),
});

const raw = schema.parse(process.env);

// Storage normalization. Precedence:
//   1. Explicit connection string (canonical or Functions-runtime name)
//   2. Table service URI + Managed Identity (canonical or Functions-runtime name)
//   3. Azurite default for local dev
const explicitConnString =
  raw.AZURE_STORAGE_CONNECTION_STRING ?? raw.AzureWebJobsStorage;
const explicitTableUri =
  raw.AZURE_STORAGE_TABLE_URI ?? raw.AzureWebJobsStorage__tableServiceUri;

const storageConnectionString =
  explicitConnString ?? (explicitTableUri ? undefined : 'UseDevelopmentStorage=true');
const storageTableUri = explicitTableUri;

const azuriteDev = storageConnectionString
  ? /UseDevelopmentStorage\s*=\s*true/i.test(storageConnectionString)
    || /devstoreaccount1/i.test(storageConnectionString)
  : false;

export const env = {
  ...raw,
  STORAGE_CONNECTION_STRING: storageConnectionString,
  STORAGE_TABLE_URI: storageTableUri,
  AZURE_OPENAI_ENDPOINT: raw.AZURE_OPENAI_ENDPOINT ?? raw.AZURE_OPENAI_API_ENDPOINT,
  AZURE_OPENAI_API_KEY: raw.AZURE_OPENAI_API_KEY ?? raw.AZURE_OPENAI_KEY,
  isAzuriteDev: azuriteDev,
};

export const isOcrConfigured = Boolean(
  env.AZURE_OPENAI_ENDPOINT && env.AZURE_OPENAI_API_KEY,
) && !/^@Microsoft\.KeyVault\(/i.test(env.AZURE_OPENAI_API_KEY ?? '');

// In production the key arrives via a Key Vault reference App Setting. If the
// keyVaultReferenceIdentity can't read the secret, the runtime leaves the
// literal "@Microsoft.KeyVault(...)" string in the env var instead of the value.
export const ocrKeyLooksUnresolved = /^@Microsoft\.KeyVault\(/i.test(
  env.AZURE_OPENAI_API_KEY ?? '',
);

export const storageMode: 'connection_string' | 'managed_identity' =
  storageConnectionString ? 'connection_string' : 'managed_identity';

// Auth is enforced only when configured; otherwise the API is open (intended
// for local dev). Token authentication is handled by the Easy Auth platform
// layer, so the app only needs OWNER_OID to authorize the owner. Production sets
// it as an App Setting (Key Vault reference).
export const isAuthConfigured = Boolean(env.OWNER_OID);

// Fail-closed flag. When set, the API must have auth fully configured or it
// refuses all requests with 503. Deployed environments set this so a dropped
// Entra App Setting can never silently open the API to the world.
export const isAuthRequired = env.REQUIRE_AUTH === 'true';

// Allowed CORS origins, or null when unset (no CORS headers emitted — the host
// owns CORS in prod, or it's same-origin local dev).
export const corsOrigins: string[] | null = env.CORS_ALLOWED_ORIGINS
  ? env.CORS_ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
  : null;
