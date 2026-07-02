/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { layerId, sessionId } from "@zettaai/edit-session";
import { describe, it, expect, beforeEach } from "vitest";

import { NgSessionLockAdapter } from "#src/editing/adapters/ng_session_lock.js";

describe("NgSessionLockAdapter", () => {
  let lock: NgSessionLockAdapter;

  beforeEach(() => {
    lock = new NgSessionLockAdapter();
  });

  it("acquire rejects a second concurrent session", async () => {
    const handle = await lock.acquire(sessionId("s1"));
    expect(handle.sessionId).toBe("s1");
    expect(typeof handle.acquiredAt).toBe("number");
    await expect(lock.acquire(sessionId("s2"))).rejects.toThrow(
      /another session is active/,
    );
    handle.release();
    // After release, a fresh acquisition succeeds.
    const second = await lock.acquire(sessionId("s2"));
    expect(second.sessionId).toBe("s2");
    second.release();
  });

  it("release is idempotent", async () => {
    const handle = await lock.acquire(sessionId("s1"));
    handle.release();
    // Calling release a second time must not throw and must not free a second
    // pending acquire that would otherwise be locked out.
    expect(() => handle.release()).not.toThrow();
    expect(() => handle.release()).not.toThrow();
    const second = await lock.acquire(sessionId("s2"));
    second.release();
  });

  it("setActiveSession toggles activeSession.value and isLayerDataSourceLocked", () => {
    expect(lock.activeSession.value).toBeUndefined();
    expect(lock.isLayerDataSourceLocked(layerId("L1"))).toBe(false);

    lock.setActiveSession({
      sessionId: sessionId("s1"),
      sessionLayerIds: new Set([layerId("L1"), layerId("L2")]),
    });

    expect(lock.activeSession.value?.sessionId).toBe("s1");
    expect(lock.isLayerDataSourceLocked(layerId("L1"))).toBe(true);
    expect(lock.isLayerDataSourceLocked(layerId("L2"))).toBe(true);
    expect(lock.isLayerDataSourceLocked(layerId("L3"))).toBe(false);
  });

  it("clearActiveSession resets activeSession.value", () => {
    lock.setActiveSession({
      sessionId: sessionId("s1"),
      sessionLayerIds: new Set([layerId("L1")]),
    });
    expect(lock.activeSession.value).not.toBeUndefined();
    lock.clearActiveSession();
    expect(lock.activeSession.value).toBeUndefined();
    expect(lock.isLayerDataSourceLocked(layerId("L1"))).toBe(false);
  });

  it("release clears activeSession when sessionId matches the active session", async () => {
    const handle = await lock.acquire(sessionId("s1"));
    lock.setActiveSession({
      sessionId: sessionId("s1"),
      sessionLayerIds: new Set([layerId("L1")]),
    });
    expect(lock.activeSession.value).not.toBeUndefined();
    handle.release();
    expect(lock.activeSession.value).toBeUndefined();
  });
});
