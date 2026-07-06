/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import {
  layerId as toLayerId,
  LayerMetadataUnavailableError,
} from "@zettaai/edit-session";
import { describe, expect, it } from "vitest";

import { LayerMetadataTimeoutError } from "#src/editing/adapters/ng_layer_metadata_source.js";
import type { NmBounds } from "#src/editing/region/edit_target_compat.js";
import type { LayerAvailability } from "#src/editing/ui/session_entry/layer_availability.js";
import {
  classifyMetadataError,
  computeLayerAvailability,
  CONSTRAINT_COPY,
  effectiveRole,
  ERROR_COPY,
  noRegionOverlapDetail,
  UNSUPPORTED_IN_SESSION_DETAIL,
} from "#src/editing/ui/session_entry/layer_availability.js";
import { NotFoundError } from "#src/kvstore/index.js";
import { HttpError } from "#src/util/http_request.js";

const LAYER_NM: NmBounds = { lo: [0, 0, 0], hi: [1000, 1000, 1000] };
const REGION_NM: NmBounds = {
  lo: [5000, 5000, 5000],
  hi: [6000, 6000, 6000],
};

/** A kvstore NotFoundError wrapping an HttpError of the given status. */
function notFoundWithStatus(status: number): NotFoundError {
  const cause = new HttpError("gs://bucket/info", status, "");
  const handle = { getUrl: () => "gs://bucket/info" } as never;
  return new NotFoundError(handle, { cause });
}

describe("classifyMetadataError — type-based, all four error codes", () => {
  // fetch-failed (retriable): transport failures that a retry may fix.
  it("classifies a network/CORS failure (HttpError status 0) as fetch-failed", () => {
    const err = new HttpError("gs://b/info", 0, "Network or CORS error");
    expect(classifyMetadataError(err)).toEqual({
      code: "fetch-failed",
      retriable: true,
      detail: err.message,
    });
    expect(ERROR_COPY["fetch-failed"].tone).toBe("warning");
  });

  it("classifies an auth failure (403) as fetch-failed (retriable)", () => {
    expect(
      classifyMetadataError(new HttpError("gs://b/info", 403, "")),
    ).toEqual({
      code: "fetch-failed",
      retriable: true,
      detail: expect.any(String),
    });
    expect(
      classifyMetadataError(new HttpError("gs://b/info", 401, "")),
    ).toMatchObject({ code: "fetch-failed", retriable: true });
  });

  it("classifies a server error (5xx) as fetch-failed (retriable)", () => {
    expect(
      classifyMetadataError(new HttpError("gs://b/info", 500, "")),
    ).toMatchObject({ code: "fetch-failed", retriable: true });
  });

  it("unwraps a NotFoundError whose cause is a network failure to fetch-failed", () => {
    // The kvstore lumps CORS(0)/403/404 into NotFoundError, so the cause's
    // status — not the NotFoundError itself — decides retriability.
    expect(classifyMetadataError(notFoundWithStatus(0))).toMatchObject({
      code: "fetch-failed",
      retriable: true,
    });
  });

  // no-metadata (not retriable): the object is genuinely absent.
  it("classifies a 404 as no-metadata (not retriable)", () => {
    expect(
      classifyMetadataError(new HttpError("gs://b/info", 404, "Not Found")),
    ).toMatchObject({ code: "no-metadata", retriable: false });
    expect(classifyMetadataError(notFoundWithStatus(404))).toMatchObject({
      code: "no-metadata",
      retriable: false,
    });
    expect(ERROR_COPY["no-metadata"].badgeLabel).toBe("No metadata");
  });

  it("classifies 'sources loaded but no volume' (LayerMetadataUnavailableError) as no-metadata", () => {
    const err = new LayerMetadataUnavailableError(
      toLayerId("seg"),
      "no-volumetric-data-source",
    );
    expect(classifyMetadataError(err)).toMatchObject({
      code: "no-metadata",
      retriable: false,
    });
  });

  // unsupported-format (not retriable): fetched but this build can't use it.
  it("classifies a parse/validation error (plain Error) as unsupported-format", () => {
    const err = new Error(
      'Error parsing "encoding" property: Invalid enum value: "zfpc"',
    );
    expect(classifyMetadataError(err)).toEqual({
      code: "unsupported-format",
      retriable: false,
      detail: err.message,
    });
    expect(ERROR_COPY["unsupported-format"].badgeLabel).toBe(
      "Unsupported format",
    );
    expect(ERROR_COPY["unsupported-format"].tone).toBe("danger");
  });

  it("classifies an unsupported voxel dtype as unsupported-format", () => {
    const err = new LayerMetadataUnavailableError(
      toLayerId("seg"),
      "unsupported-data-type",
    );
    expect(classifyMetadataError(err)).toMatchObject({
      code: "unsupported-format",
      retriable: false,
    });
  });

  it("prefers the HttpError cause's message for the detail", () => {
    const nf = notFoundWithStatus(500);
    // detail comes from the wrapped HttpError (carries the status), not the
    // generic '… not found' message.
    expect(classifyMetadataError(nf).detail).toContain("500");
  });

  it("classifies a validation timeout as fetch-failed (retriable, not terminal)", () => {
    // A layer whose sources never settled is still in flight — retriable, never
    // a terminal no-metadata/unsupported-format.
    const err = new LayerMetadataTimeoutError("lyr" as never);
    expect(classifyMetadataError(err)).toMatchObject({
      code: "fetch-failed",
      retriable: true,
    });
  });
});

describe("computeLayerAvailability — tier-1 error + no-scales", () => {
  it("wraps a classified error into the error union", () => {
    const availability = computeLayerAvailability({
      status: "error",
      error: new HttpError("gs://b/info", 0, "Network or CORS error"),
    });
    expect(availability).toMatchObject({
      kind: "error",
      code: "fetch-failed",
      retriable: true,
    });
  });

  it("maps the no-scales sentinel to a non-retriable no-scales error", () => {
    expect(computeLayerAvailability({ status: "no-scales" })).toEqual({
      kind: "error",
      code: "no-scales",
      retriable: false,
    });
    expect(ERROR_COPY["no-scales"].tone).toBe("danger");
  });
});

describe("computeLayerAvailability — tier-2 constraints", () => {
  it("is fully enabled for a healthy, unconstrained layer", () => {
    const availability = computeLayerAvailability({
      status: "ok",
      unsupportedInSession: false,
    });
    expect(availability).toEqual({
      kind: "ok",
      reference: { enabled: true },
      editable: { enabled: true },
    });
  });

  it("disables both options for an unsupported-in-session layer", () => {
    const availability = computeLayerAvailability({
      status: "ok",
      unsupportedInSession: true,
    });
    const expected = {
      enabled: false,
      reason: "unsupported-in-session",
      detail: UNSUPPORTED_IN_SESSION_DETAIL,
    };
    expect(availability).toEqual({
      kind: "ok",
      reference: expected,
      editable: expected,
    });
    expect(CONSTRAINT_COPY["unsupported-in-session"].chipLabel).toBe(
      "Not available in sessions",
    );
    // Product restriction — the wording must not imply a technical fault.
    expect(UNSUPPORTED_IN_SESSION_DETAIL).not.toMatch(/broken|error|fault/i);
  });

  it("disables both options for a region-overlap failure with both extents in the detail", () => {
    const detail = noRegionOverlapDetail(LAYER_NM, REGION_NM);
    const availability = computeLayerAvailability({
      status: "ok",
      unsupportedInSession: false,
      noRegionOverlapDetail: detail,
    });
    const expected = {
      enabled: false,
      reason: "no-region-overlap",
      detail,
    };
    expect(availability).toEqual({
      kind: "ok",
      reference: expected,
      editable: expected,
    });
    expect(CONSTRAINT_COPY["no-region-overlap"].chipLabel).toBe(
      "Outside the edit region",
    );
    // Both the layer extent and the region extent appear so the user can fix it.
    expect(detail).toContain("0");
    expect(detail).toMatch(/5|6/);
  });

  it("prefers unsupported-in-session over no-region-overlap when both apply", () => {
    const availability = computeLayerAvailability({
      status: "ok",
      unsupportedInSession: true,
      noRegionOverlapDetail: noRegionOverlapDetail(LAYER_NM, REGION_NM),
    });
    expect(availability.kind).toBe("ok");
    if (availability.kind !== "ok") return;
    expect(availability.reference).toMatchObject({
      reason: "unsupported-in-session",
    });
  });
});

describe("effectiveRole — selection preservation round trip", () => {
  const ok: LayerAvailability = {
    kind: "ok",
    reference: { enabled: true },
    editable: { enabled: true },
  };
  const constrained: LayerAvailability = computeLayerAvailability({
    status: "ok",
    unsupportedInSession: true,
  });
  const errored: LayerAvailability = {
    kind: "error",
    code: "fetch-failed",
    retriable: true,
  };

  it("keeps the intended role while the layer is available", () => {
    expect(effectiveRole("editable", ok, "segmentation")).toBe("editable");
    expect(effectiveRole("reference", ok, "segmentation")).toBe("reference");
    expect(effectiveRole("off", ok, "segmentation")).toBe("off");
  });

  it("forces off when a constraint or error makes the intent unavailable", () => {
    expect(effectiveRole("editable", constrained, "segmentation")).toBe("off");
    expect(effectiveRole("reference", constrained, "segmentation")).toBe("off");
    expect(effectiveRole("editable", errored, "segmentation")).toBe("off");
  });

  it("restores the preserved intent through available → unavailable → available", () => {
    const intent = "editable";
    // available
    expect(effectiveRole(intent, ok, "segmentation")).toBe("editable");
    // → unavailable (region moved out / fetch failed): effective off, intent kept
    expect(effectiveRole(intent, errored, "segmentation")).toBe("off");
    // → available again (retry succeeds): intent re-applied, not left at off
    expect(effectiveRole(intent, ok, "segmentation")).toBe("editable");
  });

  it("never allows editable on an image layer", () => {
    expect(effectiveRole("editable", ok, "image")).toBe("off");
    expect(effectiveRole("reference", ok, "image")).toBe("reference");
  });
});
