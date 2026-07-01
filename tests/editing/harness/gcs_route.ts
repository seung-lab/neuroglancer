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
 * Redirect the built app's Google Cloud Storage reads to the local fake-gcs
 * fixtures server (TM-331, phase 2). The NG `gcs` kvstore reads/stats/lists at
 *
 *   https://storage.googleapis.com/storage/v1/b/<bucket>/o/<key>?alt=media&…
 *   https://storage.googleapis.com/storage/v1/b/<bucket>/o?delimiter=/&prefix=…
 *
 * (anonymous — see `src/kvstore/gcs/index.ts`). We intercept those with
 * Playwright and FULFILL them from the fake-gcs origin in the Node test process,
 * re-emitting the body under the original `storage.googleapis.com` URL with CORS
 * + `Cross-Origin-Resource-Policy` headers so the response loads under the
 * benchmark page's `COEP: require-corp` (a plain cross-origin redirect would be
 * blocked). The host-swap itself is the pure, unit-tested {@link rewriteGcsUrl}.
 */

import type { Page, Route } from "@playwright/test";

/** Match the GCS JSON API host the NG kvstore reads from. */
export const GCS_URL_PATTERN = /^https:\/\/storage\.googleapis\.com\//;

/**
 * Map a `storage.googleapis.com` request URL onto the local fake-gcs origin,
 * preserving the path + query (incl. NG's `?alt=media&neuroglancer=…`).
 */
export function rewriteGcsUrl(requestUrl: string, fakeBase: string): string {
  const u = new URL(requestUrl);
  return fakeBase.replace(/\/+$/, "") + u.pathname + u.search;
}

/** COEP/CORS headers so the fulfilled cross-origin body loads on the COI page. */
const COI_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "cross-origin-resource-policy": "cross-origin",
};

/**
 * Install the redirect on a Playwright page. Call BEFORE `page.goto`.
 * `fakeBase` is the fake-gcs origin (e.g. `http://localhost:9778`).
 */
export async function installGcsRoute(
  page: Page,
  fakeBase: string,
): Promise<void> {
  await page.route(GCS_URL_PATTERN, async (route: Route) => {
    const request = route.request();
    // Answer CORS preflight locally so the real GET can proceed.
    if (request.method() === "OPTIONS") {
      await route.fulfill({
        status: 204,
        headers: {
          ...COI_HEADERS,
          "access-control-allow-methods": "GET,HEAD,OPTIONS",
          "access-control-allow-headers": "*",
        },
      });
      return;
    }
    const target = rewriteGcsUrl(request.url(), fakeBase);
    let resp: Response;
    try {
      resp = await fetch(target, { method: request.method() });
    } catch (e) {
      await route.fulfill({
        status: 502,
        body: `fake-gcs fetch failed for ${target}: ${e}`,
      });
      return;
    }
    const body = Buffer.from(await resp.arrayBuffer());
    await route.fulfill({
      status: resp.status,
      headers: {
        ...COI_HEADERS,
        "content-type":
          resp.headers.get("content-type") ?? "application/octet-stream",
      },
      body,
    });
  });
}
