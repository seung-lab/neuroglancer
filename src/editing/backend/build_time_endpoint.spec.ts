/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildTimeBackendEndpoint,
  logoutBuildTimeBackendAuth,
} from "#src/editing/backend/build_time_endpoint.js";

// The `NEUROGLANCER_ZETTA_*` names are build-time defines. In the test runner
// they are undefined globals; `vi.stubGlobal` simulates a build that baked them
// in. `typeof <name>` stays safe either way.

// Stub the Google OAuth provider so the google-oauth mode is testable without a
// real login popup. `getSpy` stands in for `provider.get`; `ctorSpy` records the
// options each provider is constructed with (to assert the `prompt`).
const { getSpy, ctorSpy } = vi.hoisted(() => ({
  getSpy: vi.fn(),
  ctorSpy: vi.fn(),
}));
vi.mock("#src/util/google_oauth2.js", () => ({
  EMAIL_SCOPE: "email",
  OPENID_SCOPE: "openid",
  GoogleOAuth2CredentialsProvider: class {
    constructor(options: unknown) {
      ctorSpy(options);
    }
    get = getSpy;
  },
}));

function tokenResult(idToken: string, generation: number, expiresIn = "3600") {
  return {
    generation,
    credentials: {
      accessToken: "access",
      idToken,
      expiresIn,
      tokenType: "Bearer",
      scope: "openid email",
      email: "dev@zetta.ai",
    },
  };
}

beforeEach(() => {
  // `logoutBuildTimeBackendAuth` best-effort revokes via `fetch`; stub it so
  // tests never hit the network.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("")),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  getSpy.mockReset();
  ctorSpy.mockReset();
});

describe("buildTimeBackendEndpoint", () => {
  it("returns undefined when no backend URL define is present", () => {
    expect(buildTimeBackendEndpoint()).toBeUndefined();
  });

  it("builds an endpoint from the URL define (root only, unauthenticated)", async () => {
    vi.stubGlobal("NEUROGLANCER_ZETTA_BACKEND_URL", "https://backend.dev/api");

    const endpoint = buildTimeBackendEndpoint();
    expect(endpoint?.baseUrl).toBe("https://backend.dev/api");

    // No token → authorize is an identity, no Authorization header added.
    const out = await endpoint!.authorize({ method: "POST" });
    expect(new Headers(out.headers).has("Authorization")).toBe(false);
  });

  it("adds a static Authorization header when the token define is present", async () => {
    vi.stubGlobal("NEUROGLANCER_ZETTA_BACKEND_URL", "https://backend.dev/api");
    vi.stubGlobal("NEUROGLANCER_ZETTA_BACKEND_TOKEN", "dev-token-123");

    const endpoint = buildTimeBackendEndpoint();
    const out = await endpoint!.authorize({});
    expect(new Headers(out.headers).get("Authorization")).toBe("dev-token-123");
  });

  it("ignores a token define when no URL is set", () => {
    vi.stubGlobal("NEUROGLANCER_ZETTA_BACKEND_TOKEN", "dev-token-123");
    expect(buildTimeBackendEndpoint()).toBeUndefined();
  });
});

describe("buildTimeBackendEndpoint — google-oauth mode", () => {
  it("sends the OIDC id_token as a bearer and caches it within expiry", async () => {
    getSpy.mockResolvedValue(tokenResult("id-tok", 1));
    vi.stubGlobal("NEUROGLANCER_ZETTA_BACKEND_URL", "https://backend.dev/api");
    vi.stubGlobal("NEUROGLANCER_ZETTA_GOOGLE_CLIENT_ID_IAP", "client-abc");

    const endpoint = buildTimeBackendEndpoint();
    const first = await endpoint!.authorize({});
    expect(new Headers(first.headers).get("Authorization")).toBe(
      "Bearer id-tok",
    );

    // Second call within the token's lifetime reuses the cached token.
    await endpoint!.authorize({});
    expect(getSpy).toHaveBeenCalledOnce();
  });

  it("takes precedence over a static token define", async () => {
    getSpy.mockResolvedValue(tokenResult("id-tok", 1));
    vi.stubGlobal("NEUROGLANCER_ZETTA_BACKEND_URL", "https://backend.dev/api");
    vi.stubGlobal("NEUROGLANCER_ZETTA_GOOGLE_CLIENT_ID_IAP", "client-abc");
    vi.stubGlobal("NEUROGLANCER_ZETTA_BACKEND_TOKEN", "static-token");

    const endpoint = buildTimeBackendEndpoint();
    const out = await endpoint!.authorize({});
    expect(new Headers(out.headers).get("Authorization")).toBe("Bearer id-tok");
  });

  it("refreshes the token after it expires", async () => {
    vi.useFakeTimers();
    getSpy
      .mockResolvedValueOnce(tokenResult("tok1", 1, "3600"))
      .mockResolvedValueOnce(tokenResult("tok2", 2, "3600"));
    vi.stubGlobal("NEUROGLANCER_ZETTA_BACKEND_URL", "https://backend.dev/api");
    vi.stubGlobal("NEUROGLANCER_ZETTA_GOOGLE_CLIENT_ID_IAP", "client-abc");

    const endpoint = buildTimeBackendEndpoint();
    const first = await endpoint!.authorize({});
    expect(new Headers(first.headers).get("Authorization")).toBe("Bearer tok1");

    // Advance past the 1h expiry (minus skew) so the next call re-authenticates,
    // passing the prior credentials back to invalidate the cache.
    vi.advanceTimersByTime(3600 * 1000);
    const second = await endpoint!.authorize({});
    expect(new Headers(second.headers).get("Authorization")).toBe(
      "Bearer tok2",
    );
    expect(getSpy).toHaveBeenCalledTimes(2);
    expect(getSpy.mock.calls[1][0]).toEqual(tokenResult("tok1", 1));
  });

  it("logout revokes, clears the token, and forces the account chooser next login", async () => {
    getSpy.mockResolvedValue(tokenResult("id-tok", 1));
    vi.stubGlobal("NEUROGLANCER_ZETTA_BACKEND_URL", "https://backend.dev/api");
    vi.stubGlobal("NEUROGLANCER_ZETTA_GOOGLE_CLIENT_ID_IAP", "client-abc");

    const endpoint = buildTimeBackendEndpoint();
    await endpoint!.authorize({});
    expect(getSpy).toHaveBeenCalledOnce();
    // First login uses a silent provider (no forced prompt).
    expect(ctorSpy.mock.calls[0][0]).toMatchObject({ prompt: undefined });

    expect(logoutBuildTimeBackendAuth()).toBe(true);

    // Best-effort revoke was posted to Google with the cached access token.
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toContain(
      "oauth2.googleapis.com/revoke",
    );
    expect((fetchMock.mock.calls[0][1] as RequestInit).body).toContain(
      "access",
    );

    // Re-fetches a fresh token, now via a provider that forces the chooser.
    await endpoint!.authorize({});
    expect(getSpy).toHaveBeenCalledTimes(2);
    expect(getSpy.mock.calls[1][0]).toBeUndefined();
    expect(ctorSpy.mock.calls[1][0]).toMatchObject({
      prompt: "select_account",
    });
  });

  it("logout returns false when no Google-login backend is active", () => {
    vi.stubGlobal("NEUROGLANCER_ZETTA_BACKEND_URL", "https://backend.dev/api");
    // URL-only endpoint (no client id) → no Google auth to clear.
    buildTimeBackendEndpoint();
    expect(logoutBuildTimeBackendAuth()).toBe(false);
  });
});
