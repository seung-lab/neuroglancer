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
  getBackendEndpoint,
} from "#src/editing/backend/backend_endpoint.js";
import { fetchOk } from "#src/util/http_request.js";

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
   * @throws {BackendUnavailableError} if no endpoint is registered.
   * @throws {HttpError} on network/CORS failure or a non-OK HTTP status.
   */
  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const endpoint = this.requireEndpoint(path);
    const url = joinBackendUrl(endpoint.baseUrl, path);
    const authorized = await endpoint.authorize(init);
    return fetchOk(url, authorized);
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
