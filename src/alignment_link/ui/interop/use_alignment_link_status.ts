/**
 * @license
 * Copyright 2026 Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { useEffect, useState } from "preact/hooks";

import type { AlignmentModel } from "#src/alignment_link/alignment_link_math.js";
import type {
  AlignmentLinkSession,
  AlignmentLinkStatus,
} from "#src/alignment_link/alignment_link_session.js";

export type { AlignmentLinkStatus } from "#src/alignment_link/alignment_link_session.js";

/**
 * The narrow UI-facing slice of the alignment-link session: the live status
 * plus the handful of commands the menu section needs. Components depend on
 * this shape, not on the session class.
 */
export interface AlignmentLinkUi {
  status: AlignmentLinkStatus;
  /** Layers with local annotations, for the "Lines from" selector. */
  annotationLayerNames: string[];
  setEnabled(enabled: boolean): void;
  setModel(model: AlignmentModel): void;
  setLayerName(name: string | undefined): void;
  swapDirection(): void;
}

/**
 * Seam hook wrapping an (optional) alignment-link session: subscribes to its
 * status and exposes only what the UI consumes. Returns `undefined` when no
 * session is present so callers can skip rendering the section. Hooks run
 * unconditionally, so the caller may pass `undefined` on any render.
 */
export function useAlignmentLinkStatus(
  session: AlignmentLinkSession | undefined,
): AlignmentLinkUi | undefined {
  const [status, setStatus] = useState<AlignmentLinkStatus | undefined>(
    session?.status.value,
  );
  useEffect(() => {
    if (session === undefined) {
      setStatus(undefined);
      return;
    }
    const update = () => setStatus(session.status.value);
    session.status.changed.add(update);
    update();
    return () => {
      session.status.changed.remove(update);
    };
  }, [session]);
  if (session === undefined) return undefined;
  return {
    status: status ?? session.status.value,
    annotationLayerNames: session.annotationLayerNames(),
    setEnabled: (enabled) => session.setEnabled(enabled),
    setModel: (model) => session.setModel(model),
    setLayerName: (name) => session.setLayerName(name),
    swapDirection: () => session.swapDirection(),
  };
}
