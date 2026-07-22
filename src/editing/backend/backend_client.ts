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
 * @file `BackendClient` (TM-347): the single, layer-independent HTTP entry
 * point onto the Zetta backend. Tools (and, after TM-348, save) issue requests
 * through it instead of constructing their own `fetch` calls, so endpoint and
 * auth come from one injected {@link BackendEndpoint} rather than from any
 * layer's datasource.
 *
 * The client holds no endpoint of its own: it reads the registered endpoint
 * **lazily, per request**, so host re-injection and token refresh take effect
 * immediately with no re-wiring. When no endpoint is registered it throws
 * {@link BackendUnavailableError} — callers gate on the host's
 * `backendAvailable` watchable to avoid hitting that path.
 */

import {
  type BackendEndpoint,
  BackendAuthExpiredError,
  getBackendEndpoint,
  isAuthExpiredSignal,
  setBackendAuthExpired,
} from "#src/editing/backend/backend_endpoint.js";
import { fetchOk, HttpError } from "#src/util/http_request.js";

/**
 * Thrown by {@link BackendClient} when a request is attempted but no
 * {@link BackendEndpoint} is registered. Distinct from `HttpError` so callers
 * can tell "backend not wired up" apart from "backend returned an error".
 */
export class BackendUnavailableError extends Error {
  constructor(readonly path: string) {
    super(
      `No backend endpoint is registered; cannot reach "${path}". ` +
        `The embedding host must call configureBackend() first.`,
    );
    this.name = "BackendUnavailableError";
  }
}

/**
 * Join a request `path` onto an endpoint `baseUrl`, preserving any query string
 * already present on the base (e.g. a host-baked `subportal_id`) and merging in
 * any query the path itself carries (path keys win on conflict).
 *
 * `path` is treated as relative to the base's path even if it begins with `/`,
 * and carries the API group, so `baseUrl="https://h/api"` (the backend root) +
 * `path="/segmentation/propagate_mask"` yields
 * `https://h/api/segmentation/propagate_mask` — the base path is preserved, not
 * reset to the origin by the leading slash.
 */
export function joinBackendUrl(baseUrl: string, path: string): string {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/, "");
  const queryIndex = path.indexOf("?");
  const rawPath = queryIndex === -1 ? path : path.slice(0, queryIndex);
  const rawQuery = queryIndex === -1 ? "" : path.slice(queryIndex + 1);

  const relPath = rawPath.replace(/^\/+/, "");
  url.pathname = relPath ? `${basePath}/${relPath}` : basePath;

  if (rawQuery) {
    const pathParams = new URLSearchParams(rawQuery);
    // Drop base values for any key the path also sets, then append every path
    // value. `append` (not `set`) is essential: repeated keys like
    // `resolution`/`bbox_start` carry a value per axis, and `set` would collapse
    // each to a single value (→ backend tuple validation fails).
    for (const key of new Set(pathParams.keys())) {
      url.searchParams.delete(key);
    }
    for (const [key, value] of pathParams) {
      url.searchParams.append(key, value);
    }
  }
  return url.toString();
}

/**
 * Layer-independent HTTP client for the Zetta backend. One instance per session
 * (owned by `EditSessionHost`); construct with no arguments — it resolves the
 * endpoint from the registry on every call.
 */
export class BackendClient {
  /**
   * Issue an authenticated request to `path` (relative to the endpoint's
   * `baseUrl`). Applies the endpoint's `authorize` to `init`, then fetches via
   * `fetchOk` (which retries transient 429/503/504 and throws `HttpError` on a
   * non-OK final response).
   *
   * On a `401` — the credential `authorize` supplied was rejected, typically a
   * token that went stale between mint and use — give the endpoint one chance to
   * {@link BackendEndpoint.invalidate} its cached credential, re-authorize, and
   * retry **exactly once**. Any other status, a second `401`, or an endpoint
   * without `invalidate` propagates unchanged: those are genuine failures, not
   * staleness, and retrying would loop. `fetchOk`'s transient (429/503/504)
   * retries are unaffected — they never surface here.
   *
   * If `authorize` rejects with an auth-expired signal
   * ({@link isAuthExpiredSignal} — the host cannot mint a credential and only
   * user re-authentication can fix it), that is terminal: flip
   * {@link setBackendAuthExpired} and rethrow a typed
   * {@link BackendAuthExpiredError} without retrying (a retry can't help, and
   * the host drives re-auth out of band). A subsequent successful request
   * clears the flag. Both the initial and the retry attempt run through
   * {@link attempt}, so an auth-expired re-mint on the retry path is flagged and
   * typed too (not leaked raw) — this is the common trigger: a stale token 401s,
   * `invalidate()` clears it, and the re-mint then fails because the session died.
   *
   * The single retry re-sends the same `init`, so its `body` must be replayable.
   * Today's callers pass `FormData` (`postMultipart`) or `ArrayBuffer`/`Blob`
   * (`postBinary`) bodies, all re-readable; a one-shot `ReadableStream` body
   * could not be retried, but nothing sends one.
   *
   * @throws {BackendUnavailableError} if no endpoint is registered.
   * @throws {BackendAuthExpiredError} if the host's auth expired.
   * @throws {HttpError} on network/CORS failure or a non-OK HTTP status.
   */
  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const endpoint = this.requireEndpoint(path);
    const url = joinBackendUrl(endpoint.baseUrl, path);
    try {
      return await this.attempt(endpoint, url, init);
    } catch (error) {
      // Stale credential → invalidate + retry ONCE. The retry runs through the
      // same guard (`attempt`), so an auth-expired re-mint is flagged + typed,
      // not leaked raw. Any other status, a second failure, an endpoint without
      // `invalidate`, or an already-typed BackendAuthExpiredError propagates —
      // those are genuine failures, and retrying would loop.
      if (
        error instanceof HttpError &&
        error.status === 401 &&
        endpoint.invalidate !== undefined
      ) {
        endpoint.invalidate();
        return await this.attempt(endpoint, url, init);
      }
      throw error;
    }
  }

  /**
   * One authorize→fetch attempt. Applies `authorize`, fetches via `fetchOk`, and
   * on success clears the auth-expired flag. If `authorize` (or the fetch)
   * rejects with an auth-expired signal, flips {@link setBackendAuthExpired} and
   * rethrows a typed {@link BackendAuthExpiredError}; every other error passes
   * through unchanged (e.g. an `HttpError 401` the caller may retry).
   */
  private async attempt(
    endpoint: BackendEndpoint,
    url: string,
    init: RequestInit,
  ): Promise<Response> {
    try {
      const response = await fetchOk(url, await endpoint.authorize(init));
      // A request got through — auth is healthy again; clear any expired flag.
      setBackendAuthExpired(false);
      return response;
    } catch (error) {
      // Host can't mint a credential (portal session expired). Terminal — re-auth
      // is the host's job — so flag it and surface a typed error.
      if (isAuthExpiredSignal(error)) {
        setBackendAuthExpired(true);
        throw error instanceof BackendAuthExpiredError
          ? error
          : new BackendAuthExpiredError();
      }
      throw error;
    }
  }

  /** POST a `multipart/form-data` body (e.g. tool compute inputs). */
  postMultipart(
    path: string,
    form: FormData,
    init: RequestInit = {},
  ): Promise<Response> {
    // Note: do NOT set Content-Type — the browser adds the multipart boundary.
    return this.request(path, { ...init, method: "POST", body: form });
  }

  /** POST a raw binary body, defaulting the Content-Type to octet-stream. */
  postBinary(
    path: string,
    body: ArrayBuffer | ArrayBufferView | Blob,
    init: RequestInit = {},
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    if (!headers.has("Content-Type")) {
      headers.set("Content-Type", "application/octet-stream");
    }
    return this.request(path, {
      ...init,
      method: "POST",
      body: body as BodyInit,
      headers,
    });
  }

  /** Whether a request would currently succeed in reaching the backend. */
  get available(): boolean {
    return getBackendEndpoint() !== undefined;
  }

  private requireEndpoint(path: string): BackendEndpoint {
    const endpoint = getBackendEndpoint();
    if (endpoint === undefined) {
      throw new BackendUnavailableError(path);
    }
    return endpoint;
  }
}
