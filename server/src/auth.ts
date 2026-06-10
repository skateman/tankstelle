// Microsoft Entra ID authorization for the Tankstelle API.
//
// Token authentication (signature, issuer, audience, expiry) is performed by the
// Azure App Service Authentication ("Easy Auth") platform layer, which injects the
// validated identity as the base64 `x-ms-client-principal` header. This middleware
// only authorizes: it requires the access_as_user scope and that the `oid` claim
// equals OWNER_OID (single-user lock).
//
// Enforced only when OWNER_OID is configured; unset ⇒ no-op (local dev). Any
// non-local deployment MUST sit behind Easy Auth (or a proxy that injects a
// trusted `x-ms-client-principal` header).

import type { MiddlewareHandler } from 'hono';
import { env, isAuthConfigured, isAuthRequired } from './env.js';

// The delegated scope the SPA requests (api://spa/access_as_user). Access tokens
// carry it in `scp`; ID tokens never do. Requiring it rejects an ID token being
// replayed as an API credential (both share aud = SPA client id + oid = owner).
const REQUIRED_SCOPE = 'access_as_user';

// Easy Auth injects the validated principal here (base64 JSON of token claims).
const PRINCIPAL_HEADER = 'x-ms-client-principal';

type PrincipalClaim = { typ: string; val: string };
type ClientPrincipal = { claims?: PrincipalClaim[] };

function parsePrincipal(headerValue: string): ClientPrincipal | null {
  try {
    const json = Buffer.from(headerValue, 'base64').toString('utf8');
    return JSON.parse(json) as ClientPrincipal;
  } catch {
    return null;
  }
}

// v2 tokens use short claim names (`oid`, `scp`); some pipelines surface the long
// WS-Federation claim URIs. Match either so the lookup is robust.
function getClaim(p: ClientPrincipal, ...types: string[]): string | undefined {
  const wanted = new Set(types);
  return p.claims?.find((c) => wanted.has(c.typ))?.val;
}

/**
 * Returns the authorization middleware. When auth is not configured it is a
 * pass-through (local dev). When configured, it trusts the platform-validated
 * `x-ms-client-principal` header and enforces the owner + scope claims.
 */
export function createAuthMiddleware(): MiddlewareHandler {
  if (!isAuthConfigured) {
    // Fail closed: a deployed environment demanded auth but it isn't configured.
    // Refuse everything rather than silently serving open.
    if (isAuthRequired) {
      return async (c) =>
        c.json(
          {
            error: 'auth_unavailable',
            message: 'Authentication is required but not configured on the server.',
          },
          503,
        );
    }
    return async (_c, next) => next();
  }

  return async (c, next) => {
    const header = c.req.header(PRINCIPAL_HEADER);
    if (!header) {
      // Easy Auth should have injected this. Its absence means the platform auth
      // gate isn't in front — fail closed rather than serve unauthenticated.
      return c.json(
        { error: 'unauthenticated', message: 'Missing platform authentication principal.' },
        401,
      );
    }

    const principal = parsePrincipal(header);
    if (!principal) {
      return c.json(
        { error: 'invalid_principal', message: 'Malformed authentication principal.' },
        401,
      );
    }

    // Reject ID tokens (no `scp`) and any access token missing our scope.
    const scopeClaim = getClaim(
      principal,
      'scp',
      'http://schemas.microsoft.com/identity/claims/scope',
    );
    const scopes = scopeClaim ? scopeClaim.split(' ') : [];
    if (!scopes.includes(REQUIRED_SCOPE)) {
      return c.json(
        { error: 'insufficient_scope', message: 'Access token lacks the required scope.' },
        403,
      );
    }

    const oid = getClaim(
      principal,
      'oid',
      'http://schemas.microsoft.com/identity/claims/objectidentifier',
    );
    if (oid !== env.OWNER_OID) {
      return c.json({ error: 'forbidden', message: 'Not the owner of this app.' }, 403);
    }

    return next();
  };
}
