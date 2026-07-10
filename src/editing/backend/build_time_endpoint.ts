/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * @file Build-time {@link BackendEndpoint} for standalone / dev deployments
 * (TM-349). When neuroglancer runs on its own site there is no portal to
 * inject the backend via `configureBackend()`, so the endpoint is baked in at
 * build time through `NEUROGLANCER_*` defines (rspack `DefinePlugin`, the same
 * mechanism as `NEUROGLANCER_DEFAULT_STATE_FRAGMENT` etc.).
 *
 * Defines (all optional besides the URL):
 *  - `NEUROGLANCER_ZETTA_BACKEND_URL` — the backend **root** URL (paths carry
 *    their own API group, e.g. `/segmentation/propagate_mask`). Without it no
 *    build-time endpoint is produced.
 *  - `NEUROGLANCER_ZETTA_GOOGLE_CLIENT_ID_IAP` — enables a **Google login**
 *    auth flow: `authorize` lazily runs Google OAuth (implicit, client id only,
 *    **no secret**) and sends the resulting OIDC `id_token` as a bearer. The
 *    token's audience is this client id, which is what an Identity-Aware Proxy
 *    (IAP) in front of the backend validates. First backend call opens the
 *    Google login popup; the token is cached and silently refreshed on expiry.
 *  - `NEUROGLANCER_ZETTA_BACKEND_TOKEN` — a fallback **static bearer token** for
 *    a dev backend with no auth flow, sent as `Authorization` on every request.
 *
 * Auth precedence: Google client id > static token > none (unauthenticated).
 *
 * The static-token path is a **dev convenience only** — a build carrying a real
 * token ships that secret in its bundle. The Google-login path carries no
 * secret and is the intended standalone/dev auth for an IAP-protected backend.
 *
 * Set via `rspack.config.js` `define`, or per-invocation on the CLI, e.g.:
 *   npm run dev -- --define \
 *     'NEUROGLANCER_ZETTA_BACKEND_URL="https://backend.dev/api"'
 * Values must be JSON-stringified (the define substitutes source text).
 *
 * This is a **fallback**: the host registers it only when nothing else is
 * installed, and a later portal `configureBackend()` still wins.
 */

import type { CredentialsWithGeneration } from "#src/credentials_provider/index.js";
import type { BackendEndpoint } from "#src/editing/backend/backend_endpoint.js";
import {
  EMAIL_SCOPE,
  GoogleOAuth2CredentialsProvider,
  type OAuth2Token,
  OPENID_SCOPE,
} from "#src/util/google_oauth2.js";

declare let NEUROGLANCER_ZETTA_BACKEND_URL: string | undefined;
declare let NEUROGLANCER_ZETTA_BACKEND_TOKEN: string | undefined;
declare let NEUROGLANCER_ZETTA_GOOGLE_CLIENT_ID_IAP: string | undefined;

/** Refresh this many ms before the token's stated expiry to avoid edge misses. */
const TOKEN_EXPIRY_SKEW_MS = 60_000;

/** Google's OAuth token-revocation endpoint. */
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

// Handles into the active Google-login authorizer, wired to `logoutBackend()`.
// Set when a Google-login endpoint is built, cleared for any other endpoint.
let activeGoogleAuthReset: (() => void) | undefined;
let activeGoogleAccessToken: (() => string | undefined) | undefined;

/**
 * Best-effort revoke of the app's Google grant (removes access so a token can't
 * be silently reissued). Browser CORS may block this endpoint — failure is
 * swallowed; the forced account chooser on the next login still re-authenticates.
 */
async function revokeGoogleToken(accessToken: string): Promise<void> {
  try {
    await fetch(GOOGLE_REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `token=${encodeURIComponent(accessToken)}`,
    });
  } catch {
    // Best-effort only.
  }
}

/**
 * Dev-only logout for the Google-login backend. Clears NG's cached token,
 * best-effort revokes the grant at Google, and forces the account chooser on
 * the next login (so a cleared token is not silently reissued from the existing
 * Google session). Returns `false` if no Google-login endpoint is active.
 *
 * This cannot end Google's own SSO session — no third-party app can. For a full
 * Google sign-out the user must do so at accounts.google.com.
 */
export function logoutBuildTimeBackendAuth(): boolean {
  if (activeGoogleAuthReset === undefined) return false;
  const accessToken = activeGoogleAccessToken?.();
  activeGoogleAuthReset();
  if (accessToken !== undefined) {
    void revokeGoogleToken(accessToken);
  }
  return true;
}

/**
 * Build an `authorize` that attaches a Google OIDC `id_token` as a bearer,
 * obtained via the browser implicit flow (no client secret). The provider and
 * token are created lazily on first use, cached, and silently refreshed once
 * the cached token nears expiry. After a `logoutBackend()` the next login forces
 * the account chooser; subsequent refreshes are silent again.
 */
function makeGoogleOAuthAuthorize(
  clientId: string,
): BackendEndpoint["authorize"] {
  const makeProvider = (prompt?: "select_account") =>
    new GoogleOAuth2CredentialsProvider({
      clientId,
      scopes: [OPENID_SCOPE, EMAIL_SCOPE],
      description: "Zetta backend",
      prompt,
    });

  let provider: GoogleOAuth2CredentialsProvider | undefined;
  let current: CredentialsWithGeneration<OAuth2Token> | undefined;
  let expiryEpochMs = 0;
  let promptNextLogin = false;

  activeGoogleAuthReset = () => {
    provider = undefined;
    current = undefined;
    expiryEpochMs = 0;
    promptNextLogin = true;
  };
  activeGoogleAccessToken = () => current?.credentials.accessToken;

  return async (init) => {
    provider ??= makeProvider(promptNextLogin ? "select_account" : undefined);

    if (
      current === undefined ||
      Date.now() >= expiryEpochMs - TOKEN_EXPIRY_SKEW_MS
    ) {
      // Passing `current` back invalidates the cached credentials so the
      // provider re-authenticates (silently via `immediate` when it can).
      current = await provider.get(current);
      expiryEpochMs = Date.now() + Number(current.credentials.expiresIn) * 1000;
      if (promptNextLogin) {
        // The post-logout forced-chooser login is done; refresh silently again.
        promptNextLogin = false;
        provider = makeProvider();
      }
    }

    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${current.credentials.idToken}`);
    return { ...init, headers };
  };
}

/** Build an `authorize` that sends a fixed static bearer token. */
function makeStaticTokenAuthorize(token: string): BackendEndpoint["authorize"] {
  return (init) => {
    const headers = new Headers(init.headers);
    headers.set("Authorization", token);
    return { ...init, headers };
  };
}

/**
 * Build a {@link BackendEndpoint} from the `NEUROGLANCER_ZETTA_*` defines, or
 * `undefined` if no backend URL was baked in.
 *
 * Auth precedence: Google client id (OAuth login) > static token > none.
 */
export function buildTimeBackendEndpoint(): BackendEndpoint | undefined {
  // Each define must be touched behind its own `typeof` guard: an unset define
  // is an undeclared global, so reading it any other way throws a ReferenceError
  // (at runtime in a build that omitted it, not just in tests).
  const baseUrl =
    typeof NEUROGLANCER_ZETTA_BACKEND_URL !== "undefined"
      ? NEUROGLANCER_ZETTA_BACKEND_URL
      : undefined;
  if (baseUrl === undefined) return undefined;

  const clientId =
    typeof NEUROGLANCER_ZETTA_GOOGLE_CLIENT_ID_IAP !== "undefined"
      ? NEUROGLANCER_ZETTA_GOOGLE_CLIENT_ID_IAP
      : undefined;
  const token =
    typeof NEUROGLANCER_ZETTA_BACKEND_TOKEN !== "undefined"
      ? NEUROGLANCER_ZETTA_BACKEND_TOKEN
      : undefined;

  let authorize: BackendEndpoint["authorize"];
  if (clientId !== undefined) {
    authorize = makeGoogleOAuthAuthorize(clientId);
  } else {
    // Not a Google-login endpoint — drop any prior logout handles so
    // `logoutBackend()` reports nothing to clear.
    activeGoogleAuthReset = undefined;
    activeGoogleAccessToken = undefined;
    authorize =
      token !== undefined ? makeStaticTokenAuthorize(token) : (init) => init;
  }

  return { baseUrl, authorize };
}
