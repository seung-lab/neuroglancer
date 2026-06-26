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
  backendEndpointChanged,
  clearBackendEndpoint,
  getBackendEndpoint,
  hasBackendEndpoint,
  registerBackendEndpoint,
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
