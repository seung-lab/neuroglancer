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
 * @file The **backend access seam** (TM-347): a single, layer-independent way
 * for the edit session to reach the Zetta backend (tool compute endpoints such
 * as `propagate_mask`, and — once migrated, TM-348 — the `/cutout` save write).
 *
 * Unlike datasource access, which is per-layer (a layer's URL drives its
 * `baseUrl`, and `middleauth`/`ngauth` OAuth2 is scoped to that data source),
 * the Zetta backend works with **any layer regardless of its datasource**.
 * Drawing the endpoint or auth from a layer's middleauth credentials would be
 * the wrong well and would break that independence. So this seam is global:
 * one {@link BackendEndpoint} for the whole session, not one per layer.
 *
 * The endpoint is **injected by the embedding host** (the portal) at
 * viewer-ready, mirroring how the save backend is installed — see
 * `src/editing/adapters/save_backend.ts`, whose registry shape this module
 * deliberately follows. NG does not auto-register one; until the host does,
 * {@link hasBackendEndpoint} is `false` and backend-dependent UI stays gated.
 *
 * Standalone deployments (no portal iframe) will later register their own
 * endpoint with a build-time `baseUrl` and an `authorize` backed by auth0 or a
 * same-origin cookie (TM-349). Because both halves are hidden behind
 * {@link BackendEndpoint}, neither tools nor the client change when that lands.
 */

import { NullarySignal } from "#src/util/signal.js";

/**
 * Layer-independent description of the Zetta backend the edit session talks to.
 *
 * Both fields are deliberately opaque to NG: the host decides where the backend
 * lives ({@link baseUrl}) and how requests are authenticated ({@link authorize}).
 */
export interface BackendEndpoint {
  /**
   * Absolute **root** URL of the Zetta backend (the deployment's REMOTE_API
   * origin) — NOT a single API group. `BackendClient` joins request paths onto
   * this, and each path carries its own API group, e.g.
   * `/segmentation/propagate_mask` or, later, `/painting/...`. One endpoint
   * therefore serves every group. Independent of any layer.
   */
  readonly baseUrl: string;

  /**
   * Apply authentication to an outgoing request, returning the (possibly new)
   * `RequestInit` the client will fetch with.
   *
   * Chosen over a `getToken()` shape so a single abstraction covers every
   * deployment without the client ever changing:
   *  - bearer token (portal/iframe): set an `Authorization` header;
   *  - same-origin cookie (standalone behind a shared proxy): set
   *    `credentials: "include"` and return `init` otherwise untouched;
   *  - auth0 silent-token (standalone): mint/refresh, then set the header.
   *
   * Subportal scoping and token lifetime live entirely inside the host's
   * implementation — NG never sees them. May be async (e.g. token refresh).
   *
   * May reject with an error tagged `code === BACKEND_AUTH_EXPIRED_CODE` when
   * the host cannot mint a credential and only user re-authentication can fix it
   * (portal session expired). {@link BackendClient} treats that as terminal (no
   * retry) — see {@link BackendAuthExpiredError}.
   */
  authorize(init: RequestInit): Promise<RequestInit> | RequestInit;

  /**
   * Drop whatever credential {@link authorize} last handed out, so the next
   * `authorize` call mints a fresh one. `BackendClient` calls this after a `401`
   * response — the signal that the credential went stale between mint and use —
   * then re-authorizes and retries the request exactly once.
   *
   * Opaque like {@link authorize}: it says nothing about tokens, so every
   * deployment fits. A bearer-token host clears its cached token; a same-origin
   * cookie host has nothing to drop and may omit this entirely (a `401` then
   * simply propagates, since a retry could not help). Optional for that reason.
   */
  invalidate?(): void;
}

/**
 * Code an {@link BackendEndpoint.authorize} rejection carries when the host
 * cannot currently mint a credential and only user re-authentication can fix it
 * (e.g. the portal's session expired and its token refresh failed). Distinct
 * from a stale credential (which is a `401` the host recovers via
 * {@link BackendEndpoint.invalidate} + retry): re-authenticating is out of the
 * client's hands, so {@link BackendClient} must not retry — it surfaces a typed
 * {@link BackendAuthExpiredError} and flips {@link isBackendAuthExpired}.
 *
 * Stringly-typed on purpose: the portal's `authorize` is an injected ES5 script
 * that cannot import this class, so it rejects with a plain error tagged
 * `code === BACKEND_AUTH_EXPIRED_CODE`. Keep this value in sync with the portal
 * bootstrap (`backend-access.bootstrap.ts`).
 */
export const BACKEND_AUTH_EXPIRED_CODE = "auth-expired";

/**
 * Typed error surfaced by {@link BackendClient} when a request fails because the
 * host's auth expired (see {@link BACKEND_AUTH_EXPIRED_CODE}). Tools can catch
 * this to show a "session expired" state instead of a generic failure, and know
 * the operation is not retryable until the host re-authenticates.
 */
export class BackendAuthExpiredError extends Error {
  readonly code = BACKEND_AUTH_EXPIRED_CODE;
  constructor(
    message = "Backend authentication expired; re-authentication required.",
  ) {
    super(message);
    this.name = "BackendAuthExpiredError";
  }
}

/** Whether `err` carries the {@link BACKEND_AUTH_EXPIRED_CODE} auth-expiry tag. */
export function isAuthExpiredSignal(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === BACKEND_AUTH_EXPIRED_CODE
  );
}

let authExpired = false;

/**
 * Dispatched whenever {@link isBackendAuthExpired} flips. The host mirrors this
 * into a reactive `backendAuthExpired` watchable so tool UI can gate on it
 * (mirrors {@link backendEndpointChanged} → `backendAvailable`).
 */
export const backendAuthExpiredChanged = new NullarySignal();

/** Whether the last backend request failed because the host's auth expired. */
export function isBackendAuthExpired(): boolean {
  return authExpired;
}

/**
 * Set by {@link BackendClient}: `true` on an auth-expired failure, `false` on
 * any successful request. Dispatches {@link backendAuthExpiredChanged} on change.
 */
export function setBackendAuthExpired(value: boolean): void {
  if (authExpired !== value) {
    authExpired = value;
    backendAuthExpiredChanged.dispatch();
  }
}

/**
 * Dispatched whenever the registered endpoint changes (register or clear). The
 * host mirrors this into a reactive `backendAvailable` watchable so UI can gate
 * backend-dependent controls on whether the backend is actually wired up.
 */
export const backendEndpointChanged = new NullarySignal();

let currentEndpoint: BackendEndpoint | undefined;

/**
 * Install the session's backend endpoint. The embedding host (the portal) calls
 * this at viewer-ready; a later call replaces the previous endpoint (e.g. on
 * re-auth). Dispatches {@link backendEndpointChanged}.
 */
export function registerBackendEndpoint(endpoint: BackendEndpoint): void {
  currentEndpoint = endpoint;
  backendEndpointChanged.dispatch();
}

/** The currently registered endpoint, or `undefined` if none is installed. */
export function getBackendEndpoint(): BackendEndpoint | undefined {
  return currentEndpoint;
}

/**
 * Remove the registered endpoint. Dispatches {@link backendEndpointChanged}
 * only if one was actually installed (so idempotent clears are silent).
 */
export function clearBackendEndpoint(): void {
  if (currentEndpoint !== undefined) {
    currentEndpoint = undefined;
    backendEndpointChanged.dispatch();
  }
}

/** Whether a backend endpoint is currently registered — i.e. the backend is reachable. */
export function hasBackendEndpoint(): boolean {
  return currentEndpoint !== undefined;
}
