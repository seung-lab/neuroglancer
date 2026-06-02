/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { afterEach, describe, it, expect, vi } from "vitest";

import type { SaveBackend } from "#src/editing/adapters/save_backend.js";
import {
  clearDefaultSaveBackend,
  getDefaultSaveBackend,
  getSaveBackend,
  hasAnySaveBackend,
  registerDefaultSaveBackend,
  registerSaveBackend,
  saveBackendRegistryChanged,
  unregisterSaveBackend,
} from "#src/editing/adapters/save_backend.js";

const stub: SaveBackend = {
  saveLayer: async () => ({ status: "succeeded", layerId: "x" as never, chunkCount: 0 }),
};

afterEach(() => {
  clearDefaultSaveBackend();
  unregisterSaveBackend("calcada");
  unregisterSaveBackend("gs");
});

describe("save backend registry", () => {
  it("reports no backend available by default (NG does not auto-register)", () => {
    expect(hasAnySaveBackend()).toBe(false);
    expect(getDefaultSaveBackend()).toBeUndefined();
  });

  it("becomes available when a default backend is registered", () => {
    registerDefaultSaveBackend(stub);
    expect(hasAnySaveBackend()).toBe(true);
    expect(getDefaultSaveBackend()).toBe(stub);
    clearDefaultSaveBackend();
    expect(hasAnySaveBackend()).toBe(false);
  });

  it("becomes available when a per-scheme backend is registered", () => {
    registerSaveBackend("gs", stub);
    expect(hasAnySaveBackend()).toBe(true);
    expect(getSaveBackend("gs")).toBe(stub);
  });

  it("dispatches saveBackendRegistryChanged on register and clear", () => {
    const listener = vi.fn();
    const unsubscribe = saveBackendRegistryChanged.add(listener);
    registerDefaultSaveBackend(stub);
    registerSaveBackend("calcada", stub);
    clearDefaultSaveBackend();
    unregisterSaveBackend("calcada");
    expect(listener).toHaveBeenCalledTimes(4);
    unsubscribe();
  });

  it("does not dispatch when clearing/unregistering an absent backend", () => {
    const listener = vi.fn();
    const unsubscribe = saveBackendRegistryChanged.add(listener);
    clearDefaultSaveBackend();
    unregisterSaveBackend("never-registered");
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});
