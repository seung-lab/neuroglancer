/**
 * @license
 * Copyright 2026 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loginWithMiddleAuthHelper,
  parseMiddleAuthResponse,
} from "#src/kvstore/middleauth/auth_helper.js";

class MockChannel {
  static instances: MockChannel[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  postMessage = vi.fn();
  close = vi.fn();
  constructor(public name: string) {
    MockChannel.instances.push(this);
  }
  receive(data: unknown) {
    this.onmessage?.({ data });
  }
}

const response = {
  token: "synthetic-secret",
  app_urls: ["https://app.example"],
};
let controller: AbortController;
let open: ReturnType<typeof vi.fn>;
let viewer: EventTarget;

beforeEach(() => {
  vi.useFakeTimers();
  MockChannel.instances = [];
  vi.stubGlobal("BroadcastChannel", MockChannel);
  let id = 0;
  vi.stubGlobal("crypto", {
    randomUUID: () =>
      `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
  });
  controller = new AbortController();
  open = vi.fn(() => null); // noopener returns null even on success.
  viewer = Object.assign(new EventTarget(), {
    // Vite rewrites the HTML asset URL relative to the jsdom page location.
    location: { origin: self.location.origin },
    open,
  });
  vi.stubGlobal("window", viewer);
});

afterEach(() => {
  controller.abort();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function start() {
  const promise = loginWithMiddleAuthHelper(
    "https://auth.example",
    controller.signal,
  );
  return { promise, channel: MockChannel.instances.at(-1)! };
}

function expectClean(channel: MockChannel, type: string) {
  expect(channel.postMessage).toHaveBeenLastCalledWith({ type });
  expect(channel.close).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
}

describe("isolated middleauth helper", () => {
  it("uses a fresh secret channel and noopener, not the WindowProxy", async () => {
    open.mockReturnValue(
      new Proxy(
        {},
        {
          get() {
            throw new Error("WindowProxy must not be inspected");
          },
        },
      ),
    );
    const first = start();
    const url = new URL(open.mock.calls[0][0]);
    expect(url.pathname).toMatch(/\/middleauth.html$/);
    expect(url.search).toBe("");
    expect(new URLSearchParams(url.hash.slice(1)).get("server")).toBe(
      "https://auth.example",
    );
    expect(first.channel.name).toMatch(/^middleauth-[0-9a-f-]{36}$/);
    expect(open.mock.calls[0][2]).toContain("noopener");
    first.channel.receive({ type: "ready" });
    first.channel.receive({ type: "credentials", response });
    await expect(first.promise).resolves.toEqual(response);
    expectClean(first.channel, "complete");
    const second = start();
    expect(second.channel.name).not.toBe(first.channel.name);
    second.channel.receive({ type: "credentials", response });
    await second.promise;
  });

  it("reports blocked or non-loading helper visibly after readiness timeout", async () => {
    const { promise, channel } = start();
    const check = expect(promise).rejects.toThrow("Allow popups and retry");
    await vi.advanceTimersByTimeAsync(10_000);
    await check;
    expectClean(channel, "cancel");
  });

  it("times out if heartbeats stop, without polling .closed", async () => {
    const { promise, channel } = start();
    channel.receive({ type: "ready" });
    const check = expect(promise).rejects.toThrow("stopped responding");
    await vi.advanceTimersByTimeAsync(15_000);
    await check;
    expectClean(channel, "cancel");
  });

  it("bounds the attempt even with continuous heartbeats", async () => {
    const { promise, channel } = start();
    const heartbeat = setInterval(
      () => channel.receive({ type: "heartbeat" }),
      1000,
    );
    const check = expect(promise).rejects.toThrow("Authentication timed out");
    await vi.advanceTimersByTimeAsync(300_000);
    await check;
    clearInterval(heartbeat);
    expectClean(channel, "cancel");
  });

  it("cancels on abort and removes timers and listeners", async () => {
    const { promise, channel } = start();
    const reason = new Error("cancel test");
    controller.abort(reason);
    await expect(promise).rejects.toBe(reason);
    expectClean(channel, "cancel");
    viewer.dispatchEvent(new Event("pagehide"));
    expect(channel.close).toHaveBeenCalledOnce();
  });

  it("does not open anything for an already aborted attempt", () => {
    controller.abort();
    expect(() => start()).toThrow();
    expect(open).not.toHaveBeenCalled();
    expect(MockChannel.instances).toHaveLength(0);
  });

  it("cancels when the viewer leaves", async () => {
    const { promise, channel } = start();
    viewer.dispatchEvent(new Event("pagehide"));
    await expect(promise).rejects.toThrow("viewer was closed");
    expectClean(channel, "cancel");
  });

  it.each([
    [{ type: "closed" }, "Authentication window was closed"],
    [{ type: "error", code: "popup-blocked" }, "Allow popups"],
    [
      { type: "error", code: "invalid-response" },
      "unexpected authentication response",
    ],
    [
      { type: "credentials", response: { token: "secret", app_urls: [42] } },
      "unexpected authentication response",
    ],
  ])("rejects terminal helper message %j", async (message, error) => {
    const { promise, channel } = start();
    channel.receive(message);
    await expect(promise).rejects.toThrow(error);
    expectClean(channel, "cancel");
  });

  it("ignores malformed/unknown control messages without leaking data to errors", async () => {
    const { promise, channel } = start();
    for (const data of [null, "secret", { type: "unknown", token: "secret" }])
      channel.receive(data);
    channel.receive({ type: "error", code: "secret" });
    await expect(promise).rejects.toThrow(
      "Authentication helper failed or timed out",
    );
    expectClean(channel, "cancel");
  });

  it("cleans up if opening throws", async () => {
    open.mockImplementation(() => {
      throw new Error("internal secret");
    });
    const { promise, channel } = start();
    await expect(promise).rejects.toThrow(
      "Failed to create authentication helper window",
    );
    expectClean(channel, "cancel");
  });
});

describe("middleauth response validation", () => {
  it.each([
    null,
    {},
    { token: "", app_urls: [] },
    { token: "secret", app_urls: [1] },
  ])("rejects invalid response %j without reflecting its fields", (data) => {
    expect(() => parseMiddleAuthResponse(data)).toThrow(
      /^Received unexpected authentication response$/,
    );
  });
  it("copies only validated fields", () => {
    expect(
      parseMiddleAuthResponse({ ...response, extra: "not relayed" }),
    ).toEqual(response);
  });
});
