/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BackendClient,
  BackendUnavailableError,
  joinBackendUrl,
} from "#src/editing/backend/backend_client.js";
import {
  BACKEND_AUTH_EXPIRED_CODE,
  BackendAuthExpiredError,
  clearBackendEndpoint,
  isBackendAuthExpired,
  registerBackendEndpoint,
  setBackendAuthExpired,
} from "#src/editing/backend/backend_endpoint.js";
import { HttpError } from "#src/util/http_request.js";

let fetchMock: ReturnType<typeof vi.fn>;

/** An error tagged like the portal bootstrap's rejection (no shared class). */
function authExpiredRejection(): Promise<never> {
  return Promise.reject(
    Object.assign(new Error("expired"), { code: BACKEND_AUTH_EXPIRED_CODE }),
  );
}

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  clearBackendEndpoint();
  setBackendAuthExpired(false);
  vi.unstubAllGlobals();
});

describe("joinBackendUrl", () => {
  // baseUrl is the backend ROOT; the API group lives in the path, e.g.
  // "/segmentation/propagate_mask" or later "/painting/...".
  it("appends a grouped path onto the base root", () => {
    expect(joinBackendUrl("https://h/api", "segmentation/propagate_mask")).toBe(
      "https://h/api/segmentation/propagate_mask",
    );
  });

  it("treats a leading-slash path as relative to the base path, not the origin", () => {
    expect(
      joinBackendUrl("https://h/api", "/segmentation/propagate_mask"),
    ).toBe("https://h/api/segmentation/propagate_mask");
  });

  it("tolerates a trailing slash on the base", () => {
    expect(
      joinBackendUrl("https://h/api/", "segmentation/propagate_mask"),
    ).toBe("https://h/api/segmentation/propagate_mask");
  });

  it("preserves a query already on the base (e.g. host-baked subportal_id)", () => {
    expect(
      joinBackendUrl(
        "https://h/api?subportal_id=abc",
        "segmentation/propagate_mask",
      ),
    ).toBe("https://h/api/segmentation/propagate_mask?subportal_id=abc");
  });

  it("merges base and path query, with the path winning on conflict", () => {
    expect(
      joinBackendUrl(
        "https://h/api?subportal_id=abc&keep=1",
        "segmentation/x?subportal_id=z",
      ),
    ).toBe("https://h/api/segmentation/x?keep=1&subportal_id=z");
  });

  it("preserves repeated path query keys (e.g. per-axis resolution/bbox)", () => {
    const url = joinBackendUrl(
      "https://h/api?subportal_id=abc",
      "painting/cutout?path=gs://b/p&resolution=64&resolution=64&resolution=45" +
        "&bbox_start=6144&bbox_start=4864&bbox_start=5304",
    );
    const params = new URL(url).searchParams;
    expect(params.getAll("resolution")).toEqual(["64", "64", "45"]);
    expect(params.getAll("bbox_start")).toEqual(["6144", "4864", "5304"]);
    // Base-only keys survive alongside the repeated path keys.
    expect(params.get("subportal_id")).toBe("abc");
  });
});

describe("BackendClient", () => {
  it("throws BackendUnavailableError when no endpoint is registered", async () => {
    const client = new BackendClient();
    await expect(client.request("/propagate_mask")).rejects.toBeInstanceOf(
      BackendUnavailableError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(client.available).toBe(false);
  });

  it("fetches the joined URL and applies authorize", async () => {
    const authorize = vi.fn((init: RequestInit) => {
      const headers = new Headers(init.headers);
      headers.set("Authorization", "token-123");
      return { ...init, headers };
    });
    registerBackendEndpoint({
      baseUrl: "https://h/api",
      authorize,
    });

    const client = new BackendClient();
    await client.request("/segmentation/propagate_mask", { method: "POST" });

    expect(authorize).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://h/api/segmentation/propagate_mask");
    expect(
      new Headers((init as RequestInit).headers).get("Authorization"),
    ).toBe("token-123");
  });

  it("resolves the endpoint lazily, so re-injection takes effect", async () => {
    const client = new BackendClient();

    registerBackendEndpoint({
      baseUrl: "https://first/seg",
      authorize: (init) => init,
    });
    await client.request("/a");

    registerBackendEndpoint({
      baseUrl: "https://second/seg",
      authorize: (init) => init,
    });
    await client.request("/b");

    expect(fetchMock.mock.calls[0][0]).toBe("https://first/seg/a");
    expect(fetchMock.mock.calls[1][0]).toBe("https://second/seg/b");
  });

  it("maps a non-OK response to HttpError", async () => {
    fetchMock.mockResolvedValueOnce(new Response("bad", { status: 400 }));
    registerBackendEndpoint({
      baseUrl: "https://h/api",
      authorize: (init) => init,
    });

    const client = new BackendClient();
    await expect(client.request("/x")).rejects.toBeInstanceOf(HttpError);
  });

  it("posts multipart bodies without forcing a Content-Type", async () => {
    registerBackendEndpoint({
      baseUrl: "https://h/api",
      authorize: (init) => init,
    });
    const form = new FormData();
    form.append("metadata", "{}");

    const client = new BackendClient();
    await client.postMultipart("/segmentation/propagate_mask", form);

    const [, init] = fetchMock.mock.calls[0];
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).body).toBe(form);
    expect(new Headers((init as RequestInit).headers).has("Content-Type")).toBe(
      false,
    );
  });

  it("posts binary bodies defaulting to application/octet-stream", async () => {
    registerBackendEndpoint({
      baseUrl: "https://h/api",
      authorize: (init) => init,
    });

    const client = new BackendClient();
    await client.postBinary("/x", new Uint8Array([1, 2, 3]));

    const [, init] = fetchMock.mock.calls[0];
    expect((init as RequestInit).method).toBe("POST");
    expect(new Headers((init as RequestInit).headers).get("Content-Type")).toBe(
      "application/octet-stream",
    );
  });
});

describe("BackendClient — 401 retry & auth expiry", () => {
  it("invalidates and retries once on a backend 401, then succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("stale", { status: 401 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    let token = "stale";
    const invalidate = vi.fn(() => {
      token = "fresh";
    });
    const authorize = vi.fn((init: RequestInit) => {
      const headers = new Headers(init.headers);
      headers.set("Authorization", token);
      return { ...init, headers };
    });
    registerBackendEndpoint({ baseUrl: "https://h/api", authorize, invalidate });

    const client = new BackendClient();
    const res = await client.request("/x");

    expect(res.status).toBe(200);
    expect(invalidate).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The retry carried the refreshed credential.
    expect(
      new Headers((fetchMock.mock.calls[1][1] as RequestInit).headers).get(
        "Authorization",
      ),
    ).toBe("fresh");
  });

  it("retries at most once — a second 401 propagates as HttpError", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 401 }));
    const invalidate = vi.fn();
    registerBackendEndpoint({
      baseUrl: "https://h/api",
      authorize: (init) => init,
      invalidate,
    });

    const client = new BackendClient();
    await expect(client.request("/x")).rejects.toBeInstanceOf(HttpError);
    expect(invalidate).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 401 when the endpoint has no invalidate", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 401 }));
    registerBackendEndpoint({
      baseUrl: "https://h/api",
      authorize: (init) => init,
    });

    const client = new BackendClient();
    await expect(client.request("/x")).rejects.toBeInstanceOf(HttpError);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("throws BackendAuthExpiredError and flags expiry when authorize signals it, without fetching or retrying", async () => {
    const authorize = vi.fn(() => authExpiredRejection());
    const invalidate = vi.fn();
    registerBackendEndpoint({ baseUrl: "https://h/api", authorize, invalidate });

    const client = new BackendClient();
    await expect(client.request("/x")).rejects.toBeInstanceOf(
      BackendAuthExpiredError,
    );
    expect(isBackendAuthExpired()).toBe(true);
    expect(authorize).toHaveBeenCalledOnce();
    expect(invalidate).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("flags + types an auth-expired re-mint on the retry path (stale 401 → invalidate → re-auth fails)", async () => {
    // First mint OK (stale) → backend 401 → invalidate → retry mint rejects expired.
    fetchMock.mockResolvedValueOnce(new Response("stale", { status: 401 }));
    let call = 0;
    const authorize = vi.fn((init: RequestInit) => {
      call += 1;
      if (call === 1) return init;
      return authExpiredRejection();
    });
    const invalidate = vi.fn();
    registerBackendEndpoint({ baseUrl: "https://h/api", authorize, invalidate });

    const client = new BackendClient();
    // Before the fix this leaked a raw error and never set the flag.
    await expect(client.request("/x")).rejects.toBeInstanceOf(
      BackendAuthExpiredError,
    );
    expect(invalidate).toHaveBeenCalledOnce();
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(isBackendAuthExpired()).toBe(true);
  });

  it("clears the auth-expired flag once a request succeeds", async () => {
    setBackendAuthExpired(true); // simulate a prior expiry
    registerBackendEndpoint({
      baseUrl: "https://h/api",
      authorize: (init) => init,
    });

    const client = new BackendClient();
    await client.request("/x");
    expect(isBackendAuthExpired()).toBe(false);
  });
});
