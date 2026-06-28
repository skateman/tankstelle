// Microsoft Entra ID sign-in for the PWA (MSAL, redirect flow).
//
// Enabled only when the build provides VITE_ENTRA_CLIENT_ID + VITE_ENTRA_TENANT_ID.
// Locally (no env) auth is disabled and the app talks to the open dev API.
//
// Required Vite env (set at build time, e.g. in the Static Web App build):
//   VITE_ENTRA_TENANT_ID   tenant guid
//   VITE_ENTRA_CLIENT_ID   the app registration's client id
//   VITE_API_SCOPE         e.g. api://tankstelle/access_as_user
//   VITE_REDIRECT_URI      optional; defaults to window.location.origin

import {
  CacheLookupPolicy,
  PublicClientApplication,
  type AccountInfo,
} from '@azure/msal-browser';

const tenantId = import.meta.env.VITE_ENTRA_TENANT_ID as string | undefined;
const clientId = import.meta.env.VITE_ENTRA_CLIENT_ID as string | undefined;
const apiScope = import.meta.env.VITE_API_SCOPE as string | undefined;
const redirectUri =
  (import.meta.env.VITE_REDIRECT_URI as string | undefined) ??
  (typeof window !== 'undefined' ? window.location.origin : undefined);

export const isAuthEnabled = Boolean(tenantId && clientId && apiScope);

const msal = isAuthEnabled
  ? new PublicClientApplication({
      auth: {
        clientId: clientId!,
        authority: `https://login.microsoftonline.com/${tenantId}`,
        redirectUri,
      },
      cache: {
        // localStorage survives the iOS PWA standalone redirect round-trip.
        cacheLocation: 'localStorage',
      },
    })
  : null;

let initialized = false;

// Guards against a redirect loop if interactive re-auth itself can't produce a
// usable token: we only auto-redirect once per tab session.
const REAUTH_GUARD = 'tankstelle.reauth';

/** Initialize MSAL and process any redirect response. Call once before render. */
export async function initAuth(): Promise<void> {
  if (!msal || initialized) return;
  await msal.initialize();
  const result = await msal.handleRedirectPromise();
  if (result?.account) {
    msal.setActiveAccount(result.account);
    // A redirect completed successfully — clear the re-auth guard.
    sessionStorage.removeItem(REAUTH_GUARD);
  } else {
    const accounts = msal.getAllAccounts();
    if (accounts.length > 0) msal.setActiveAccount(accounts[0]!);
  }
  initialized = true;
}

export function getAccount(): AccountInfo | null {
  return msal?.getActiveAccount() ?? null;
}

export async function signIn(): Promise<void> {
  if (!msal) return;
  await msal.loginRedirect({ scopes: [apiScope!] });
}

export async function signOut(): Promise<void> {
  if (!msal) return;
  sessionStorage.removeItem(REAUTH_GUARD);
  await msal.logoutRedirect({ account: msal.getActiveAccount() ?? undefined });
}

/** Acquire an access token for the API, silently if possible. */
export async function getToken(): Promise<string | null> {
  if (!msal) return null;
  const account = msal.getActiveAccount();
  if (!account) return null;
  try {
    const r = await msal.acquireTokenSilent({
      scopes: [apiScope!],
      account,
      cacheLookupPolicy: CacheLookupPolicy.AccessTokenAndRefreshToken,
    });
    sessionStorage.removeItem(REAUTH_GUARD);
    return r.accessToken;
  } catch {
    if (!sessionStorage.getItem(REAUTH_GUARD)) {
      sessionStorage.setItem(REAUTH_GUARD, '1');
      await msal.acquireTokenRedirect({ scopes: [apiScope!], account });
    }
    return null;
  }
}
