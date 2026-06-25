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
  clearBackendEndpoint,
  registerBackendEndpoint,
} from "#src/editing/backend/backend_endpoint.js";
import { HttpError } from "#src/util/http_request.js";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  clearBackendEndpoint();
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
    ).toBe("https://h/api/segmentation/x?subportal_id=z&keep=1");
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
