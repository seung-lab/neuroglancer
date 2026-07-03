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
 * @file Structured layer-availability model for the Enter Edit Session modal
 * (TM-374). This is the single source of truth for BOTH the availability
 * taxonomy and every user-facing string. Validation produces a
 * `LayerAvailability` discriminated union here, in the session-model layer;
 * components receive the union and map it to UI mechanically — they never
 * parse or pattern-match error message strings, and they hold no copy of
 * their own.
 *
 * Two tiers:
 *  - `error`  — the layer's data is broken or unreadable, so the layer is
 *    unusable (row-level): the role control is forced to Off. Split into
 *    `no-metadata` / `no-scales` / `fetch-failed`.
 *  - `ok`     — the layer is healthy, but some session options may not apply
 *    to it (option-level constraints): `unsupported-in-session` /
 *    `no-region-overlap` disable Reference/Editable while the layer itself
 *    stays fully usable outside the session.
 */

import { LayerMetadataUnavailableError } from "@zettaai/edit-session";

import { LayerMetadataTimeoutError } from "#src/editing/adapters/ng_layer_metadata_source.js";
import type { NmBounds } from "#src/editing/region/edit_target_compat.js";
import { formatNmBounds } from "#src/editing/region/edit_target_compat.js";
import type { LayerKind } from "#src/editing/ui/layer_kind.js";
// Type-only import — no runtime cycle with the row component.
import type { LayerRole } from "#src/editing/ui/session_entry/layer_row.js";
import { NotFoundError } from "#src/kvstore/index.js";
import { HttpError } from "#src/util/http_request.js";

/** Tier-1 row-level error codes (layer unusable). */
export type LayerErrorCode =
  | "no-metadata"
  | "no-scales"
  | "fetch-failed"
  | "unsupported-format";

/**
 * A resolved tier-1 error, stored on the row's state. `detail` is the original
 * technical message (absent for `no-scales`, which is derived not thrown).
 */
export interface LayerLoadError {
  readonly code: LayerErrorCode;
  readonly retriable: boolean;
  readonly detail?: string;
}

/** Tier-2 option-level constraint codes (layer healthy, options restricted). */
export type OptionReasonCode = "unsupported-in-session" | "no-region-overlap";

/** Availability of a single role option (Reference or Editable). */
export type OptionAvailability =
  | { enabled: true }
  | { enabled: false; reason: OptionReasonCode; detail?: string };

/**
 * The full availability of a layer for the edit session. Components switch on
 * `kind` and map each case to its badge / inline-note / disabled-segment
 * treatment.
 */
export type LayerAvailability =
  | {
      kind: "error";
      code: LayerErrorCode;
      retriable: boolean;
      /** Original technical message, for tooltip + logs only. */
      detail?: string;
    }
  | {
      kind: "ok";
      reference: OptionAvailability;
      editable: OptionAvailability;
    };

// ---------------------------------------------------------------------------
// Copy map — every user-facing string, keyed by code/reason. No string
// literals for these live in components.
// ---------------------------------------------------------------------------

/** Visual severity of an error badge. */
export type BadgeTone = "danger" | "warning";

export interface ErrorCopy {
  /** Short badge label (sentence case, no terminal punctuation). */
  readonly badgeLabel: string;
  /** Human-readable badge tooltip. */
  readonly tooltip: string;
  readonly tone: BadgeTone;
}

export const ERROR_COPY: Record<LayerErrorCode, ErrorCopy> = {
  "no-metadata": {
    badgeLabel: "No metadata",
    tooltip:
      "Layer info file not found (no-volumetric-data-source). " +
      "The layer can't be loaded.",
    tone: "danger",
  },
  "no-scales": {
    badgeLabel: "No scales",
    tooltip: "Layer metadata contains no scales.",
    tone: "danger",
  },
  "fetch-failed": {
    badgeLabel: "Load failed",
    tooltip: "Couldn't fetch layer metadata. Check your connection and retry.",
    tone: "warning",
  },
  "unsupported-format": {
    badgeLabel: "Unsupported format",
    tooltip:
      "The layer's metadata loaded but isn't supported by this build. " +
      "See the details for the exact parse error.",
    tone: "danger",
  },
};

export interface ConstraintCopy {
  /**
   * Short status-chip label that fits the middle slot on one line. The full
   * wording lives in the tooltip / accessible detail.
   */
  readonly chipLabel: string;
}

export const CONSTRAINT_COPY: Record<OptionReasonCode, ConstraintCopy> = {
  "unsupported-in-session": {
    chipLabel: "Not available in sessions",
  },
  "no-region-overlap": {
    chipLabel: "Outside the edit region",
  },
};

/** aria-label for the fetch-failed retry button. */
export const RETRY_ARIA_LABEL = "Retry loading metadata";

/**
 * Full detail for the `unsupported-in-session` constraint (tooltip on the
 * inline note and hover hint on the disabled segments). Product restriction,
 * NOT a technical fault — the wording must not imply the layer is broken.
 */
export const UNSUPPORTED_IN_SESSION_DETAIL =
  "Calcada, Graphene, and https+middleauth layers can't be part of an edit " +
  "session. They stay available outside the session.";

/**
 * Full detail for `no-region-overlap`. Includes both extents so the user can
 * fix it by moving the region.
 */
export function noRegionOverlapDetail(
  layerNm: NmBounds,
  regionNm: NmBounds,
): string {
  return (
    `Layer bounds ${formatNmBounds(layerNm)} don't overlap the edit region ` +
    `${formatNmBounds(regionNm)}. Adjust the region to include this layer.`
  );
}

// ---------------------------------------------------------------------------
// Mapping — validation result → LayerAvailability
// ---------------------------------------------------------------------------

/**
 * The transport-level HTTP status behind an error, if any — read from the
 * typed error objects the fetch/kvstore layers throw, never parsed from a
 * message. `HttpError.status` is `0` for a network/CORS failure and the real
 * code otherwise. A `NotFoundError` wraps the original `HttpError` on its
 * `cause` (the kvstore lumps CORS/403/404 into "not found", so the cause's
 * status is what actually distinguishes them); a `NotFoundError` with no such
 * cause is a definitive absence, i.e. `404`.
 */
function httpStatusOf(err: unknown): number | undefined {
  if (err instanceof HttpError) return err.status;
  if (err instanceof NotFoundError) {
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof HttpError) return cause.status;
    return 404;
  }
  return undefined;
}

/** The most specific technical message available for the detail tooltip. */
function detailOf(err: unknown): string {
  if (err instanceof NotFoundError) {
    const cause = (err as { cause?: unknown }).cause;
    // The HttpError cause carries the status; its message is more accurate
    // than the generic "… not found" for network/auth failures.
    if (cause instanceof Error) return cause.message;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Classify a rejected `metadataSource.resolve(...)` into a tier-1 error — by
 * the error's TYPE, never by matching message substrings. The fork's metadata
 * adapter re-throws the original typed error (see `ng_layer_metadata_source`),
 * so the discriminants here are the real `HttpError`/`NotFoundError` classes
 * and the library's `LayerMetadataUnavailableError`.
 *
 * - Transport failure with an HTTP status: `404`/`410` → the object is
 *   genuinely absent (`no-metadata`, not retriable); everything else — `0`
 *   (network/CORS), `401`/`403` (auth), `5xx`, `429` — is transient
 *   (`fetch-failed`, retriable).
 * - `LayerMetadataUnavailableError`: `unsupported-data-type` → the volume
 *   loaded but its dtype is unsupported (`unsupported-format`); otherwise the
 *   sources loaded cleanly but expose no volume (`no-metadata`).
 * - Any other `Error` reached us after transport succeeded → the metadata was
 *   fetched but couldn't be parsed/validated by this build
 *   (`unsupported-format`).
 */
export function classifyMetadataError(err: unknown): {
  code: LayerErrorCode;
  retriable: boolean;
  detail: string;
} {
  const detail = detailOf(err);
  // A layer that never settled is still in flight, not broken — retriable.
  if (err instanceof LayerMetadataTimeoutError) {
    return { code: "fetch-failed", retriable: true, detail };
  }
  const status = httpStatusOf(err);
  if (status !== undefined) {
    if (status === 404 || status === 410) {
      return { code: "no-metadata", retriable: false, detail };
    }
    return { code: "fetch-failed", retriable: true, detail };
  }
  if (err instanceof LayerMetadataUnavailableError) {
    if (err.reason === "unsupported-data-type") {
      return { code: "unsupported-format", retriable: false, detail };
    }
    return { code: "no-metadata", retriable: false, detail };
  }
  return { code: "unsupported-format", retriable: false, detail };
}

/**
 * The single reason (if any) that restricts a healthy layer's role options.
 * `unsupported-in-session` (data-source scheme) wins over `no-region-overlap`
 * — it's the more fundamental restriction and never clears by moving the
 * region.
 */
export interface OkConstraints {
  /** True when the layer's data-source scheme is unsupported in sessions. */
  readonly unsupportedInSession: boolean;
  /**
   * Set when the edit region falls fully outside the layer's data bounds; the
   * string is the full detail (built via {@link noRegionOverlapDetail}).
   */
  readonly noRegionOverlapDetail?: string;
}

/** Build the shared option availability for a healthy layer's constraints. */
function optionFor(constraints: OkConstraints): OptionAvailability {
  if (constraints.unsupportedInSession) {
    return {
      enabled: false,
      reason: "unsupported-in-session",
      detail: UNSUPPORTED_IN_SESSION_DETAIL,
    };
  }
  if (constraints.noRegionOverlapDetail !== undefined) {
    return {
      enabled: false,
      reason: "no-region-overlap",
      detail: constraints.noRegionOverlapDetail,
    };
  }
  return { enabled: true };
}

/**
 * Structured description of a layer's validation outcome, independent of any
 * async plumbing — this is what {@link computeLayerAvailability} maps.
 */
export type LayerValidation =
  | { status: "error"; error: unknown }
  | { status: "no-scales" }
  | ({ status: "ok" } & OkConstraints);

/**
 * Map a validation outcome to the `LayerAvailability` union. Both Reference
 * and Editable share the same option availability — the session constraints
 * (scheme, region overlap) apply to them identically. (Editable can be
 * independently disabled for image layers, but that's a display-kind concern
 * handled by the row component, not part of this taxonomy.)
 */
export function computeLayerAvailability(
  validation: LayerValidation,
): LayerAvailability {
  switch (validation.status) {
    case "error": {
      const { code, retriable, detail } = classifyMetadataError(
        validation.error,
      );
      return { kind: "error", code, retriable, detail };
    }
    case "no-scales":
      return { kind: "error", code: "no-scales", retriable: false };
    case "ok": {
      const option = optionFor(validation);
      return { kind: "ok", reference: option, editable: option };
    }
  }
}

/**
 * Derive the effective role from the user's preserved `intent` and the layer's
 * current availability — the core of selection preservation (TM-374). A tier-1
 * error forces `off`; a constraint disabling the intended option forces `off`;
 * otherwise the intent stands, so restoring availability restores the pick.
 * Image layers can never be `editable` (a display-kind rule outside the
 * taxonomy).
 */
export function effectiveRole(
  intent: LayerRole,
  availability: LayerAvailability | undefined,
  kind: LayerKind,
): LayerRole {
  if (availability?.kind === "error") return "off";
  if (intent === "off") return "off";
  if (intent === "reference") {
    return availability?.reference.enabled === false ? "off" : "reference";
  }
  // intent === "editable"
  if (kind === "image") return "off";
  return availability?.editable.enabled === false ? "off" : "editable";
}
