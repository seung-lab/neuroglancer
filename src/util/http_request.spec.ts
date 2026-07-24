/**
 * @license
 * Copyright 2024 Google Inc.
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
  fetchOk,
  maxTimeoutRetries,
  requestTimeoutMilliseconds,
} from "#src/util/http_request.js";

// A request that never returns response headers on its own; it settles only when the signal passed
// to `fetch` is aborted (by the per-attempt timeout or by the caller).
function hangUntilAborted(init: RequestInit | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal;
    signal?.addEventListener("abort", () =>
      reject(signal.reason ?? new DOMException("Aborted", "AbortError")),
    );
  });
}

describe("fetchOk per-request timeout and retry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("re-issues a GET that times out, then resolves on the retry", async () => {
    const fetchMock = vi.fn((_input: RequestInfo, init?: RequestInit) => {
      // First attempt hangs (the "stuck" head node); the nudge succeeds.
      if (fetchMock.mock.calls.length === 1) return hangUntilAborted(init);
      return Promise.resolve(new Response("ok", { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const responsePromise = fetchOk("http://example.test/chunk");
    await vi.advanceTimersByTimeAsync(requestTimeoutMilliseconds);
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after exhausting the timeout-retry cap", async () => {
    const fetchMock = vi.fn((_input: RequestInfo, init?: RequestInit) =>
      hangUntilAborted(init),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = fetchOk("http://example.test/chunk").then(
      () => "resolved",
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(
      requestTimeoutMilliseconds * (maxTimeoutRetries + 1) + 10,
    );

    expect(((await result) as DOMException).name).toBe("TimeoutError");
    expect(fetchMock).toHaveBeenCalledTimes(maxTimeoutRetries + 1);
  });

  it("does not retry when the caller aborts", async () => {
    const fetchMock = vi.fn((_input: RequestInfo, init?: RequestInit) =>
      hangUntilAborted(init),
    );
    vi.stubGlobal("fetch", fetchMock);

    const controller = new AbortController();
    const result = fetchOk("http://example.test/chunk", {
      signal: controller.signal,
    }).then(
      () => "resolved",
      (error: unknown) => error,
    );
    controller.abort(new DOMException("Cancelled", "AbortError"));
    await vi.advanceTimersByTimeAsync(requestTimeoutMilliseconds * 3);

    const error = await result;
    expect((error as DOMException).name).toBe("AbortError");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not apply the timeout to non-idempotent POST requests", async () => {
    let sawAbort = false;
    const fetchMock = vi.fn((_input: RequestInfo, init?: RequestInit) => {
      init?.signal?.addEventListener("abort", () => {
        sawAbort = true;
      });
      return new Promise<Response>(() => {});
    });
    vi.stubGlobal("fetch", fetchMock);

    let settled = false;
    void fetchOk("http://example.test/write", { method: "POST" }).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.advanceTimersByTimeAsync(requestTimeoutMilliseconds * 5);

    expect(sawAbort).toBe(false);
    expect(settled).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
