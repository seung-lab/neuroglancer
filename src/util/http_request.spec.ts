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

import { afterEach, describe, expect, test, vi } from "vitest";
import { read, stat } from "#src/kvstore/http/read.js";
import type { ReadableKvStore } from "#src/kvstore/index.js";
import { NotFoundError } from "#src/kvstore/index.js";
import {
  fetchOk,
  HttpError,
  isNotFoundError,
  isTransientNetworkError,
} from "#src/util/http_request.js";

const url = "https://example.com/data";

const store: ReadableKvStore = {
  read: (key, options) => read(store, key, url, options),
  stat: (key, options) => stat(store, key, url, options),
  getUrl: () => url,
  supportsOffsetReads: true,
  supportsSuffixReads: true,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("HTTP error classification", () => {
  test("network/CORS errors are transient, not missing", () => {
    const error = new HttpError(url, 0, "Network or CORS error");
    expect(isTransientNetworkError(error)).toBe(true);
    expect(isNotFoundError(error)).toBe(false);
  });

  test.each([403, 404])("HTTP %i remains missing, not transient", (status) => {
    const error = new HttpError(url, status, "missing");
    expect(isNotFoundError(error)).toBe(true);
    expect(isTransientNetworkError(error)).toBe(false);
  });

  test.each([400, 408, 429, 500, 503, 504])(
    "HTTP %i does not receive an additional network retry budget",
    (status) => {
      const error = new HttpError(url, status, "error");
      expect(isTransientNetworkError(error)).toBe(false);
      expect(isNotFoundError(error)).toBe(false);
    },
  );

  test.each([
    undefined,
    null,
    { status: 0 },
    new TypeError("decode failed"),
    new Error("model failed"),
    new Error("decode failed", { cause: new HttpError(url, 0, "network") }),
    new DOMException("cancelled", "AbortError"),
  ])("does not classify unrelated errors: %s", (error) => {
    expect(isTransientNetworkError(error)).toBe(false);
    expect(isNotFoundError(error)).toBe(false);
  });
});

describe("fetchOk", () => {
  test.each([url, new Request(url)])(
    "wraps transport TypeError without retrying: %s",
    async (input) => {
      const cause = new TypeError("Failed to fetch");
      const fetch = vi.fn().mockRejectedValue(cause);
      vi.stubGlobal("fetch", fetch);
      await expect(fetchOk(input)).rejects.toMatchObject({
        name: "HttpError",
        url,
        status: 0,
        cause,
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  test("preserves AbortError without wrapping or retrying", async () => {
    const error = new DOMException("cancelled", "AbortError");
    const fetch = vi.fn().mockRejectedValue(error);
    vi.stubGlobal("fetch", fetch);
    await expect(fetchOk(url)).rejects.toBe(error);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("does not fetch with an already aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(fetchOk(url, { signal: controller.signal })).rejects.toBe(
      controller.signal.reason,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each([429, 503, 504])(
    "retains existing HTTP %i retries",
    async (status) => {
      vi.useFakeTimers();
      const response = new Response("ok");
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status }))
        .mockResolvedValueOnce(response);
      vi.stubGlobal("fetch", fetch);
      const promise = fetchOk(url);
      await vi.runAllTimersAsync();
      await expect(promise).resolves.toBe(response);
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  test("retains the existing 32-attempt HTTP retry limit", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    const result = expect(fetchOk(url)).rejects.toMatchObject({ status: 503 });
    await vi.runAllTimersAsync();
    await result;
    expect(fetch).toHaveBeenCalledTimes(32);
  });
});

describe.each(["read", "stat"] as const)("HTTP kvstore %s", (operation) => {
  test.each([false, true])(
    "propagates transport failure with throwIfMissing=%s",
    async (throwIfMissing) => {
      const cause = new TypeError("Failed to fetch");
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(cause));
      await expect(
        store[operation]("data", { throwIfMissing }),
      ).rejects.toMatchObject({
        name: "HttpError",
        status: 0,
        cause,
      });
    },
  );

  test.each([403, 404])(
    "preserves HTTP %i missing semantics",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response(null, { status })),
      );
      await expect(store[operation]("data", {})).resolves.toBeUndefined();
      await expect(
        store[operation]("data", { throwIfMissing: true }),
      ).rejects.toBeInstanceOf(NotFoundError);
    },
  );
});
