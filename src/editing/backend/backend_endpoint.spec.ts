/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import type { BackendEndpoint } from "#src/editing/backend/backend_endpoint.js";
import {
  BACKEND_AUTH_EXPIRED_CODE,
  BackendAuthExpiredError,
  backendAuthExpiredChanged,
  backendEndpointChanged,
  clearBackendEndpoint,
  getBackendEndpoint,
  hasBackendEndpoint,
  isAuthExpiredSignal,
  isBackendAuthExpired,
  registerBackendEndpoint,
  setBackendAuthExpired,
} from "#src/editing/backend/backend_endpoint.js";

const stub: BackendEndpoint = {
  baseUrl: "https://example.test/api",
  authorize: (init) => init,
};

afterEach(() => {
  clearBackendEndpoint();
});

describe("backend endpoint registry", () => {
  it("reports no endpoint by default (NG does not auto-register)", () => {
    expect(hasBackendEndpoint()).toBe(false);
    expect(getBackendEndpoint()).toBeUndefined();
  });

  it("becomes available when an endpoint is registered", () => {
    registerBackendEndpoint(stub);
    expect(hasBackendEndpoint()).toBe(true);
    expect(getBackendEndpoint()).toBe(stub);
    clearBackendEndpoint();
    expect(hasBackendEndpoint()).toBe(false);
  });

  it("replaces the previous endpoint on re-register", () => {
    const other: BackendEndpoint = { ...stub, baseUrl: "https://other.test" };
    registerBackendEndpoint(stub);
    registerBackendEndpoint(other);
    expect(getBackendEndpoint()).toBe(other);
  });

  it("dispatches backendEndpointChanged on register and clear", () => {
    const listener = vi.fn();
    const unsubscribe = backendEndpointChanged.add(listener);
    registerBackendEndpoint(stub);
    registerBackendEndpoint(stub);
    clearBackendEndpoint();
    expect(listener).toHaveBeenCalledTimes(3);
    unsubscribe();
  });

  it("does not dispatch when clearing an absent endpoint", () => {
    const listener = vi.fn();
    const unsubscribe = backendEndpointChanged.add(listener);
    clearBackendEndpoint();
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});

describe("backend auth-expiry signal", () => {
  afterEach(() => setBackendAuthExpired(false));

  it("recognizes the tagged code and the typed error, and nothing else", () => {
    expect(isAuthExpiredSignal({ code: BACKEND_AUTH_EXPIRED_CODE })).toBe(true);
    expect(isAuthExpiredSignal(new BackendAuthExpiredError())).toBe(true);
    expect(isAuthExpiredSignal(new Error("nope"))).toBe(false);
    expect(isAuthExpiredSignal({ code: "other" })).toBe(false);
    expect(isAuthExpiredSignal(undefined)).toBe(false);
    expect(isAuthExpiredSignal(null)).toBe(false);
  });

  it("BackendAuthExpiredError carries the auth-expired code", () => {
    expect(new BackendAuthExpiredError().code).toBe(BACKEND_AUTH_EXPIRED_CODE);
  });

  it("flips the flag and dispatches only on change", () => {
    const listener = vi.fn();
    const unsubscribe = backendAuthExpiredChanged.add(listener);
    expect(isBackendAuthExpired()).toBe(false);

    setBackendAuthExpired(true);
    setBackendAuthExpired(true); // same value — no dispatch
    expect(isBackendAuthExpired()).toBe(true);
    setBackendAuthExpired(false);

    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});
