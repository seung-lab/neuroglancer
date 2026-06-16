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
 * In-app edit-session paint benchmark harness (driven by Playwright).
 *
 * Exposed as `window.__editPaintBench(opts?)`. The dev-server app is loaded with
 * an ngState that carries an `editSession` block, so the host AUTO-OPENS the
 * session + restores the brush/mask preset on load — this harness does NOT open
 * a session; it waits for the active one, then for each {case × brush size}
 * drives a real stroke via SYNTHETIC pointer events on the slice canvas
 * (exercising the full stack: scheduler → pointer→voxel → pyodide compute →
 * commit → GPU upload) and snapshots `__paintProfiler`.
 *
 * Cases: masked brush (the state's threshold + morphology preset), unmasked
 * brush, eraser.
 *
 * ⚠ Benchmark harness, NOT a unit test. The end-to-end run needs a
 * cross-origin-isolated browser with WebGL2 + pyodide (the dev-server build), so
 * it cannot run under vitest/node. A few integration details (canvas discovery,
 * pointer dispatch, settle waits) are best-effort — see `// TUNE:` markers. The
 * reusable, verified pieces are `paintProfiler.snapshot()/resetWindow()`.
 */

import { paintProfiler } from "#src/editing/tool_runtimes/paint_profiler.js";

/** One {case × size} measurement. */
export interface EditPaintBenchResult {
  readonly case: "masked-brush" | "unmasked-brush" | "eraser";
  /** Brush diameter (2r+1). */
  readonly size: number;
  readonly radius: number;
  readonly ok: boolean;
  readonly error?: string;
  /**
   * The full sectioned `__paintProfiler` summary for this stroke (params ·
   * BLOCKS-UI · ①..⑥ phase tables · counts), exactly as the console prints it,
   * minus the interactive copy hint. This is the primary output.
   */
  readonly summary: string;
  /** Selected profiler bucket totals (ms) — for the JSON artifact. */
  readonly timings: Record<string, number>;
  /** Selected profiler counters — for the JSON artifact. */
  readonly counters: Record<string, number>;
}

export interface EditPaintBenchOptions {
  /** Brush diameters to sweep. Default: 5, 51, 251, 501, 751, 1025. */
  readonly sizes?: readonly number[];
  /** Which cases to run. Default: all three. */
  readonly cases?: ReadonlyArray<EditPaintBenchResult["case"]>;
  /** rAF frames to wait after a stroke so the GPU upload buckets land. */
  readonly renderFramesAfterStroke?: number;
  /** Max ms to wait for a stroke's worker round-trip + commit to settle. */
  readonly settleTimeoutMs?: number;
  /** Max ms to wait for the host to auto-open the session from ngState. */
  readonly sessionTimeoutMs?: number;
  /** ms to let pyodide warm up after the session opens (masked path). */
  readonly warmupMs?: number;
  /** Pointermove samples in the swept drag (default 40). */
  readonly strokePoints?: number;
  /** ms between samples — pace ≈ worker round-trip so each becomes a segment (default 80). */
  readonly strokeStepMs?: number;
}

const DEFAULT_SIZES = [5, 51, 251, 501, 751, 1025] as const;

// Profiler buckets/counters surfaced per result (others dropped to keep the
// payload small across `page.evaluate`).
const TIMING_KEYS = [
  "0.stroke(total)",
  "4.handleInput(total)",
  "P.pipeline(worker)",
  "P.w.maskBuild(py)",
  "P.w.closing(py)",
  "P.w.components(py)",
  "P.slabCopy(cpu)",
  "P.write(cpu)",
  "2b.morphology(worker)",
  "2a.maskBuild(cpu)",
  "apply.total(cpu)",
  "5.mirror.fuse(cpu)",
  "6.gpu.upload(value)",
  "6.gpu.upload(mask)",
  "mt.frameDraw",
];
const COUNTER_KEYS = [
  "voxels.footprintBbox",
  "voxels.painted",
  "overlay.paint.apply.chunks",
  "gpu.uploadBytes",
  "morphology.heapPressure",
  "morphology.workerReinit",
];

type Any = any;

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pickTimings(
  buckets: Record<string, { totalMs: number }>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of TIMING_KEYS) {
    if (buckets[k] !== undefined) {
      out[k] = Math.round(buckets[k].totalMs * 10) / 10;
    }
  }
  return out;
}
function pickCounters(
  counters: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of COUNTER_KEYS) {
    if (counters[k] !== undefined) out[k] = counters[k];
  }
  return out;
}

/**
 * Element to dispatch pointer events on. The `PointerEventBridge` registers its
 * handlers on the slice PANEL element (not the shared GL canvas), so we resolve
 * the topmost element at the largest canvas's centre via `elementFromPoint` —
 * that is the interactive panel element, and bubbling carries the event to the
 * bridge. TUNE: if strokes don't register, log this element's class chain.
 */
function findDispatchTarget(): HTMLElement {
  const canvases = Array.from(
    document.querySelectorAll("canvas"),
  ) as HTMLCanvasElement[];
  let best: HTMLCanvasElement | undefined;
  let bestArea = 0;
  for (const c of canvases) {
    const r = c.getBoundingClientRect();
    const area = r.width * r.height;
    if (area > bestArea) {
      bestArea = area;
      best = c;
    }
  }
  if (best === undefined) throw new Error("editPaintBench: no canvas found");
  const r = best.getBoundingClientRect();
  const el = document.elementFromPoint(
    r.left + r.width / 2,
    r.top + r.height / 2,
  ) as HTMLElement | null;
  return el ?? best;
}

/**
 * Fire a synthetic stroke that mirrors a REAL drag: pointerdown → many
 * pointermoves SWEEPING across most of the panel (a sine zigzag, so it covers a
 * 2D band of FRESH chunks, not one stationary spot) → pointerup. Moves are paced
 * (`stepMs`, ≈ the worker round-trip) so each delivered move becomes its own
 * stroke segment — reproducing sustained load (pyodide heap growth/GC over many
 * segments) AND the per-segment apply/commit cost (`writeRegion` over fresh
 * territory). A tiny stationary wiggle (the old version) under-measured both.
 */
async function dispatchStroke(
  el: HTMLElement,
  points: number,
  stepMs: number,
): Promise<void> {
  const rect = el.getBoundingClientRect();
  const x0 = rect.left + rect.width * 0.12;
  const x1 = rect.left + rect.width * 0.88;
  const yc = rect.top + rect.height * 0.5;
  const amp = rect.height * 0.3;
  const n = Math.max(2, Math.floor(points));
  const at = (i: number): [number, number] => {
    const t = i / (n - 1);
    return [x0 + (x1 - x0) * t, yc + Math.sin(t * Math.PI * 3) * amp];
  };
  const common = {
    pointerId: 1,
    isPrimary: true,
    bubbles: true,
    cancelable: true,
  } as const;
  const [dx, dy] = at(0);
  el.dispatchEvent(
    new PointerEvent("pointerdown", {
      ...common,
      clientX: dx,
      clientY: dy,
      button: 0,
      buttons: 1,
    }),
  );
  for (let i = 1; i < n; i++) {
    const [x, y] = at(i);
    el.dispatchEvent(
      new PointerEvent("pointermove", {
        ...common,
        clientX: x,
        clientY: y,
        button: -1,
        buttons: 1,
      }),
    );
    await delay(stepMs);
  }
  const [lx, ly] = at(n - 1);
  el.dispatchEvent(
    new PointerEvent("pointerup", {
      ...common,
      clientX: lx,
      clientY: ly,
      button: 0,
      buttons: 0,
    }),
  );
}

/** A single brush stamp at `(x, y)`: down + one tiny move + up → one segment. */
function dispatchStamp(el: HTMLElement, x: number, y: number): void {
  const c = {
    pointerId: 1,
    isPrimary: true,
    bubbles: true,
    cancelable: true,
  } as const;
  el.dispatchEvent(
    new PointerEvent("pointerdown", {
      ...c,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: 1,
    }),
  );
  el.dispatchEvent(
    new PointerEvent("pointermove", {
      ...c,
      clientX: x + 2,
      clientY: y,
      button: -1,
      buttons: 1,
    }),
  );
  el.dispatchEvent(
    new PointerEvent("pointerup", {
      ...c,
      clientX: x + 2,
      clientY: y,
      button: 0,
      buttons: 0,
    }),
  );
}

/**
 * Warm the data path BEFORE measuring: a few discrete max-radius stamps spread
 * across the sweep band, each fully settled, so the EM/target chunks they touch
 * become resident. Without this the FIRST measured segment pays a cold
 * `gs://` `chunkRead` (seconds), which — being far longer than the move pacing —
 * makes `latestWins` drop every other move and collapse the stroke to ONE
 * segment (no per-segment numbers). Real painting has these chunks warm.
 * Profiler is reset after, so warmup doesn't pollute the measured window.
 */
export async function warmupEditPaintBench(
  opts: EditPaintBenchOptions & {
    warmupStamps?: number;
    warmupSettleMs?: number;
  } = {},
): Promise<{ stamps: number; ms: number }> {
  const t0 = performance.now();
  const viewer = (globalThis as unknown as { viewer?: Any }).viewer;
  const host = viewer?.editSessionHost;
  await waitForActiveSession(host, opts.sessionTimeoutMs ?? 120000);
  const ps = host.painting.state;
  const base = ps.getState();
  if (presetMask === undefined) presetMask = base.mask;
  presetRadius = base.radius ?? 512;
  ps.patchState({ radius: 512, mask: presetMask });
  host.selectTool("painting.brush");
  await delay(opts.warmupMs ?? 1500); // let pyodide boot too

  const el = findDispatchTarget();
  const rect = el.getBoundingClientRect();
  const n = Math.max(2, opts.warmupStamps ?? 8);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const x = rect.left + rect.width * (0.12 + 0.76 * t);
    const y = rect.top + rect.height * (0.3 + 0.4 * (i % 2));
    paintProfiler.enabled = true;
    paintProfiler.resetWindow();
    dispatchStamp(el, x, y);
    await waitForSettle(opts.warmupSettleMs ?? 60000);
    paintProfiler.enabled = false;
    paintProfiler.resetWindow();
  }
  return { stamps: n, ms: Math.round(performance.now() - t0) };
}

/** Wait until the host has auto-opened the session from the ngState block. */
async function waitForActiveSession(
  host: Any,
  timeoutMs: number,
): Promise<void> {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    if (
      host.activeSession?.value !== undefined &&
      host.painting !== undefined
    ) {
      return;
    }
    await delay(100);
  }
  throw new Error(
    "editPaintBench: no active session — the ngState must carry an " +
      "`editSession` block so the host auto-opens it.",
  );
}

/**
 * Heuristic settle: wait until the profiler's stroke/apply totals stop growing
 * across consecutive samples (gate + worker round-trip + commit drained), or the
 * timeout elapses. TUNE if strokes need longer.
 */
async function waitForSettle(timeoutMs: number): Promise<void> {
  const start = performance.now();
  let prev = -1;
  let stable = 0;
  while (performance.now() - start < timeoutMs) {
    await delay(50);
    const s = paintProfiler.snapshot();
    // `0.stroke(total)` is absent on the newer `worker-mask` path; the
    // `handleInput` span is the robust progress signal.
    const cur =
      (s.buckets["4.handleInput(total)"]?.totalMs ??
        s.buckets["0.stroke(total)"]?.totalMs ??
        0) + (s.buckets["apply.total(cpu)"]?.totalMs ?? 0);
    if (cur > 0 && cur === prev) {
      if (++stable >= 3) return;
    } else {
      stable = 0;
    }
    prev = cur;
  }
}

/** Module-level state shared across step calls (persists until page navigation). */
let presetMask: unknown = undefined;
let presetRadius = 512;

export interface EditPaintBenchDiag {
  readonly sessionActive: boolean;
  readonly crossOriginIsolated: boolean;
  /** Painting state read after warmup. */
  readonly hasMaskPreset: boolean;
  readonly targetLayerId: unknown;
  readonly maskImageLayerId: unknown;
  readonly canvas: { w: number; h: number } | null;
  /** Tag of the element the strokes will be dispatched on. */
  readonly dispatchTarget: string;
  readonly error?: string;
}

/**
 * Step 1: wait for the auto-opened session, warm up pyodide, capture the brush +
 * mask preset, and return diagnostics. Called ONCE before the sweep so a single
 * short `page.evaluate` surfaces whether the session/mask/canvas are usable
 * (rather than hiding it inside a long opaque sweep).
 */
export async function prepareEditPaintBench(
  opts: EditPaintBenchOptions = {},
): Promise<EditPaintBenchDiag> {
  const viewer = (globalThis as unknown as { viewer?: Any }).viewer;
  const host = viewer?.editSessionHost;
  const diag: {
    -readonly [K in keyof EditPaintBenchDiag]: EditPaintBenchDiag[K];
  } = {
    sessionActive: false,
    crossOriginIsolated:
      (globalThis as unknown as { crossOriginIsolated?: boolean })
        .crossOriginIsolated === true,
    hasMaskPreset: false,
    targetLayerId: undefined,
    maskImageLayerId: undefined,
    canvas: null,
    dispatchTarget: "none",
  };
  try {
    if (host === undefined)
      throw new Error("window.viewer.editSessionHost missing");
    await waitForActiveSession(host, opts.sessionTimeoutMs ?? 120000);
    diag.sessionActive = true;
    await delay(opts.warmupMs ?? 4000); // pyodide warmup
    const base = host.painting.state.getState();
    presetMask = base.mask;
    presetRadius = base.radius ?? 512;
    diag.hasMaskPreset = base.mask !== undefined && base.mask !== null;
    diag.targetLayerId = base.targetLayerId;
    diag.maskImageLayerId = base.mask?.imageLayerId;
    const el = findDispatchTarget();
    const r = el.getBoundingClientRect();
    diag.canvas = { w: Math.round(r.width), h: Math.round(r.height) };
    diag.dispatchTarget =
      (el.tagName || "?") +
      (el.className ? "." + String(el.className).split(" ")[0] : "");
  } catch (e) {
    diag.error = e instanceof Error ? e.message : String(e);
  }
  return diag;
}

/**
 * Step 2: run ONE {case × size} stroke and return its row + a tiny diagnostic
 * (`maskedComputeRan`, `strokeFired`). Each call is its own short
 * `page.evaluate`, so a mid-sweep navigation only loses the current cell and the
 * spec can report partial results + pinpoint the failing cell.
 */
export async function stepEditPaintBench(input: {
  case: EditPaintBenchResult["case"];
  size: number;
  settleTimeoutMs?: number;
  renderFramesAfterStroke?: number;
  /** Pointermove samples in the swept drag (default 40). */
  strokePoints?: number;
  /** ms between samples — pace ≈ worker round-trip so each becomes a segment (default 80). */
  strokeStepMs?: number;
}): Promise<
  EditPaintBenchResult & { maskedComputeRan: boolean; strokeFired: boolean }
> {
  const viewer = (globalThis as unknown as { viewer?: Any }).viewer;
  const host = viewer?.editSessionHost;
  const radius = (input.size - 1) / 2;
  const row: {
    -readonly [K in keyof EditPaintBenchResult]: EditPaintBenchResult[K];
  } & { maskedComputeRan: boolean; strokeFired: boolean } = {
    case: input.case,
    size: input.size,
    radius,
    ok: false,
    summary: "",
    timings: {},
    counters: {},
    maskedComputeRan: false,
    strokeFired: false,
  };
  try {
    const ps = host.painting.state;
    ps.patchState({
      radius,
      mask: input.case === "masked-brush" ? presetMask : undefined,
    });
    host.selectTool(
      input.case === "eraser" ? "painting.erase" : "painting.brush",
    );
    await nextFrame();

    paintProfiler.enabled = true;
    paintProfiler.resetWindow();

    await dispatchStroke(
      findDispatchTarget(),
      input.strokePoints ?? 40,
      input.strokeStepMs ?? 80,
    );
    await waitForSettle(input.settleTimeoutMs ?? 60000);
    for (let i = 0; i < (input.renderFramesAfterStroke ?? 4); i++)
      await nextFrame();

    // The full sectioned block (same format as the console summary) — captured
    // BEFORE resetWindow() clears the accumulation.
    row.summary = paintProfiler.renderSummary();
    const snap = paintProfiler.snapshot();
    row.timings = pickTimings(snap.buckets);
    row.counters = pickCounters(snap.counters);
    row.strokeFired =
      snap.buckets["4.handleInput(total)"] !== undefined ||
      snap.buckets["0.stroke(total)"] !== undefined;
    row.maskedComputeRan = Object.keys(snap.buckets).some(
      (k) => k.startsWith("P.") || k.startsWith("2b."),
    );
    row.ok = row.summary.length > 0;
  } catch (e) {
    row.error = e instanceof Error ? e.message : String(e);
  } finally {
    paintProfiler.enabled = false;
    paintProfiler.resetWindow();
  }
  return row;
}

/** Restore the original brush preset so the app is left as loaded. */
export function finishEditPaintBench(): void {
  const viewer = (globalThis as unknown as { viewer?: Any }).viewer;
  try {
    viewer?.editSessionHost?.painting?.state?.patchState?.({
      radius: presetRadius,
      mask: presetMask,
    });
  } catch {
    /* best effort */
  }
}

/** Convenience: full sweep in one call (the spec prefers prepare + step). */
export async function runEditPaintBench(
  opts: EditPaintBenchOptions = {},
): Promise<EditPaintBenchResult[]> {
  await prepareEditPaintBench(opts);
  const sizes = opts.sizes ?? DEFAULT_SIZES;
  const cases = opts.cases ?? ["masked-brush", "unmasked-brush", "eraser"];
  const results: EditPaintBenchResult[] = [];
  for (const c of cases) {
    for (const size of sizes) {
      results.push(
        await stepEditPaintBench({
          case: c,
          size,
          settleTimeoutMs: opts.settleTimeoutMs,
          renderFramesAfterStroke: opts.renderFramesAfterStroke,
          strokePoints: opts.strokePoints,
          strokeStepMs: opts.strokeStepMs,
        }),
      );
    }
  }
  finishEditPaintBench();
  return results;
}

// Attach to the window so Playwright can call the steps. Harmless dev surface,
// mirroring `__paintProfiler` — only does work when invoked.
Object.assign(globalThis as unknown as Record<string, unknown>, {
  __editPaintBench: runEditPaintBench,
  __editPaintBenchPrepare: prepareEditPaintBench,
  __editPaintBenchWarmup: warmupEditPaintBench,
  __editPaintBenchStep: stepEditPaintBench,
  __editPaintBenchFinish: finishEditPaintBench,
});
