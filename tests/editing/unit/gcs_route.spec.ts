/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, it, expect } from "vitest";

import {
  GCS_URL_PATTERN,
  rewriteGcsUrl,
} from "#tests/editing/harness/gcs_route.js";

describe("rewriteGcsUrl", () => {
  it("swaps the host and preserves the NG read path + query", () => {
    const ng =
      "https://storage.googleapis.com/storage/v1/b/zetta-editing-test/o/" +
      "seg_u64_cseg%2Finfo?alt=media&neuroglancer=deadbeef";
    expect(rewriteGcsUrl(ng, "http://localhost:9778")).toBe(
      "http://localhost:9778/storage/v1/b/zetta-editing-test/o/" +
        "seg_u64_cseg%2Finfo?alt=media&neuroglancer=deadbeef",
    );
  });

  it("preserves the list query (delimiter + prefix)", () => {
    const ng =
      "https://storage.googleapis.com/storage/v1/b/b1/o?delimiter=%2F&prefix=x%2F";
    expect(rewriteGcsUrl(ng, "http://localhost:1234")).toBe(
      "http://localhost:1234/storage/v1/b/b1/o?delimiter=%2F&prefix=x%2F",
    );
  });

  it("strips a trailing slash from the base", () => {
    expect(
      rewriteGcsUrl("https://storage.googleapis.com/storage/v1/b", "http://h/"),
    ).toBe("http://h/storage/v1/b");
  });

  it("pattern matches the GCS host only", () => {
    expect(
      GCS_URL_PATTERN.test("https://storage.googleapis.com/storage/v1"),
    ).toBe(true);
    expect(GCS_URL_PATTERN.test("https://example.com/storage/v1")).toBe(false);
  });
});
