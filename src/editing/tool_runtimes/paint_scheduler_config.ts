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
 * Runtime-tunable stroke scheduling mode (TM-317 scheduler fix).
 *
 * The masked-brush lag is a SCHEDULING problem, not a compute one: a single
 * disk is ~8 ms in the pyodide worker, but the current scheduler coalesces all
 * movement accumulated while the worker is busy into ONE swept capsule per call
 * with no drop, so per-call work grows with drag speed (a feedback loop). This
 * exposes two modes so they can be A/B-compared live from the console without a
 * rebuild:
 *
 *  - `latestWins` (default, the fix): the old voxel-editor model. While a
 *    compute is in flight, intermediate cursor positions are DROPPED — only the
 *    latest is kept (true drop-to-latest, NOT serialize-the-backlog). Per-call
 *    work is bounded: a capsule from the last-painted point to the latest cursor
 *    while that span is within the cap, else a single disk at the latest cursor
 *    (the connecting span is skipped — a gap, hidden by brush overlap at normal
 *    speed). Paint can never fall unboundedly behind the cursor.
 *  - `coalesce` (the current behavior): the whole accumulated movement becomes
 *    one swept capsule per call, no drop. Kept for A/B reference.
 *
 * Console usage (toggle applies on the next stroke):
 *
 *     __paintScheduler.mode = 'coalesce'      // feel the current behavior
 *     __paintScheduler.mode = 'latestWins'    // the fix (default)
 *     __paintScheduler.maxStampSpacing = 128  // override the per-call cap (voxels)
 *     __paintScheduler.maxStampSpacing = 0    // 0 = auto (≈ brush radius)
 *     __paintScheduler.help()
 */

export type PaintSchedulerMode = "latestWins" | "coalesce";

class PaintSchedulerConfig {
  /** Active scheduling mode. Applies to the next dispatched segment. */
  mode: PaintSchedulerMode = "latestWins";

  /**
   * `latestWins` per-call cap on the painted span, in voxels at the target
   * resolution. `0` ⇒ AUTO: resolve to the brush radius (so the bounded capsule
   * is ≈ half a disk of extra work regardless of brush size). Set `> 0` to pin
   * an absolute cap. Beyond the cap the scheduler drops to a single disk at the
   * latest cursor. Ignored in `coalesce` mode.
   */
  maxStampSpacing = 0;

  /**
   * Resolve the effective cap for a stroke of the given radius. AUTO (`0`)
   * returns the radius (min 1); an explicit positive value is used as-is.
   */
  resolveCap(radiusVoxels: number): number {
    if (this.maxStampSpacing > 0) return this.maxStampSpacing;
    return Math.max(1, Math.floor(radiusVoxels));
  }

  /** Print the modes and current values to the console. */
  help(): void {
    // eslint-disable-next-line no-console
    console.log(
      [
        "[paint-scheduler] stroke scheduling mode",
        `  mode            = '${this.mode}'   ('latestWins' = bounded+drop-to-latest, the fix | 'coalesce' = swept-capsule no-drop, current)`,
        `  maxStampSpacing = ${this.maxStampSpacing}   (latestWins per-call cap in voxels; 0 = auto ≈ brush radius)`,
        "  set:  __paintScheduler.mode = 'coalesce'  |  __paintScheduler.maxStampSpacing = 128",
      ].join("\n"),
    );
  }
}

/**
 * Process-wide singleton, also exposed on `globalThis.__paintScheduler` so the
 * mode + cap can be toggled live from the browser console without a rebuild.
 */
export const paintScheduler = new PaintSchedulerConfig();
(
  globalThis as unknown as { __paintScheduler?: PaintSchedulerConfig }
).__paintScheduler = paintScheduler;

// Announce once on init in a real browser so the toggle is discoverable from the
// console (skipped under jsdom so the test output stays clean).
if (
  typeof navigator !== "undefined" &&
  !/jsdom/i.test(navigator.userAgent ?? "")
) {
  // eslint-disable-next-line no-console
  console.log(
    `[paint-scheduler] mode='${paintScheduler.mode}' — toggle live via __paintScheduler.help()`,
  );
}
