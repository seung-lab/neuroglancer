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
 * Phase-0 measurement instrumentation for the painting hot path (TM-304).
 *
 * Buckets the main-thread cost of a brush stroke so we can see where the time
 * actually goes at large brush sizes — slab assembly (#1) vs mask build (#2)
 * vs batch build (#3) vs the morphology worker round-trip — before deciding
 * what to move off the main thread.
 *
 * DISABLED by default with near-zero overhead (one boolean check per phase, no
 * per-voxel cost). Toggle at runtime from the iframe console:
 *
 *     __paintProfiler.enabled = true     // start measuring
 *     …paint a few strokes…              // a summary prints ~400ms after each
 *     __paintProfiler.enabled = false    // stop
 *
 * Timings are wall-clock `performance.now()` deltas. CPU-bound buckets (labelled
 * `cpu`) are what block the main thread; `worker`/`io` buckets are awaits that
 * yield the main thread (shown for context, not blocking cost).
 */

interface Bucket {
  totalMs: number;
  calls: number;
  maxMs: number;
}

// ---------------------------------------------------------------------------
// Bucket taxonomy — group + human label + role, so the flat list of recorded
// names renders as labelled phases instead of an alphabetical jumble.
// ---------------------------------------------------------------------------

/**
 * Pipeline phase a bucket belongs to. Order here is the print order.
 *  - `compute`  : main-thread brush compute (slab copy, threshold, scatter…).
 *  - `worker`   : pyodide round-trip (off-thread; does NOT block the UI).
 *  - `apply`    : write → commit into the session (main-thread).
 *  - `render`   : GPU upload + frame draw (main-thread render loop).
 *  - `spans`    : containers (stroke/handleInput totals) — shown, never summed.
 *  - `health`   : long-task stalls + worker-health flags.
 *  - `other`    : anything unmapped (still shown, nothing lost).
 */
type Phase =
  | "compute"
  | "worker"
  | "apply"
  | "render"
  | "spans"
  | "health"
  | "other";

/**
 * Role of a bucket for accounting:
 *  - `cpu`      : main-thread CPU that BLOCKS the UI (counted in the headline).
 *  - `io`       : a main-thread `await` that YIELDS (shown, not counted as CPU).
 *  - `worker`   : off-thread worker time (counted as off-thread, not blocking).
 *  - `container`: a span/round-trip that CONTAINS other buckets (not summed).
 *  - `render`   : main-thread render-loop cost (shown separately from BLOCKS-UI).
 *  - `stall`    : long-task catch-all.
 */
type Role = "cpu" | "io" | "worker" | "container" | "render" | "stall";

interface BucketMeta {
  phase: Phase;
  label: string;
  role: Role;
}

const PHASE_ORDER: Phase[] = [
  "compute",
  "worker",
  "apply",
  "render",
  "spans",
  "health",
  "other",
];

const PHASE_TITLE: Record<Phase, string> = {
  compute: "① COMPUTE · main-thread (blocks UI)",
  worker: "② COMPUTE · pyodide worker (off-thread)",
  apply: "③ APPLY → COMMIT · main-thread (blocks UI)",
  render: "④ RENDER · main-thread",
  spans: "⑤ SPANS (containers — not summed)",
  health: "⑥ STALLS / WORKER HEALTH",
  other: "⑦ OTHER (unmapped)",
};

/**
 * Exact-name → metadata for every bucket the pipeline records. Both masked
 * paths map to the SAME labels: the old split (`2b.*`, main-thread mask + worker
 * morphology) and the new whole-pipeline (`P.*`, TM-317) so the table reads the
 * same regardless of which ran; a `path:` tag in the header says which it was.
 */
const BUCKET_META: Record<string, BucketMeta> = {
  // ── spans (containers) ───────────────────────────────────────────────
  "0.stroke(total)": { phase: "spans", label: "stroke — compute (incl. worker await)", role: "container" },
  "4.handleInput(total)": { phase: "spans", label: "handleInput — compute + apply", role: "container" },

  // ── compute · main-thread ────────────────────────────────────────────
  "1a.chunkRead(io)": { phase: "compute", label: "chunkRead (await)", role: "io" },
  "P.chunkRead(io)": { phase: "compute", label: "chunkRead (await)", role: "io" },
  "1b.slabCopy(cpu)": { phase: "compute", label: "slabCopy (EM → slab)", role: "cpu" },
  "P.slabCopy(cpu)": { phase: "compute", label: "slabCopy (EM → slab)", role: "cpu" },
  "2a.maskBuild(cpu)": { phase: "compute", label: "maskBuild (threshold+gate)", role: "cpu" },
  "cmp.footprint(cpu)": { phase: "compute", label: "footprint raster", role: "cpu" },
  "2c.write(cpu)": { phase: "compute", label: "scatter (sample-back)", role: "cpu" },
  "P.write(cpu)": { phase: "compute", label: "scatter (sample-back)", role: "cpu" },
  "3.build(cpu)": { phase: "compute", label: "batchBuild", role: "cpu" },

  // ── compute · worker (off-thread) ────────────────────────────────────
  "2b.morphology(worker)": { phase: "worker", label: "Σ morphology round-trip", role: "container" },
  "P.pipeline(worker)": { phase: "worker", label: "Σ pipeline round-trip", role: "container" },
  "2b.w.maskBuild(py)": { phase: "worker", label: "· maskBuild (py)", role: "worker" },
  "P.w.maskBuild(py)": { phase: "worker", label: "· maskBuild (py)", role: "worker" },
  "2b.w.closing(py)": { phase: "worker", label: "· closing (py)", role: "worker" },
  "P.w.closing(py)": { phase: "worker", label: "· closing (py)", role: "worker" },
  "2b.w.components(py)": { phase: "worker", label: "· components (py)", role: "worker" },
  "P.w.components(py)": { phase: "worker", label: "· components (py)", role: "worker" },
  "2b.w.marshalIn(py)": { phase: "worker", label: "· marshalIn (py)", role: "worker" },
  "P.w.marshalIn(py)": { phase: "worker", label: "· marshalIn (py)", role: "worker" },
  "2b.w.marshalOut(py)": { phase: "worker", label: "· marshalOut (py)", role: "worker" },
  "P.w.marshalOut(py)": { phase: "worker", label: "· marshalOut (py)", role: "worker" },
  "2b.w.convertOut(js)": { phase: "worker", label: "· convertOut (js)", role: "worker" },
  "P.w.convertOut(js)": { phase: "worker", label: "· convertOut (js)", role: "worker" },
  "2b.w.call(js)": { phase: "worker", label: "· callJs (js↔py span ⊇ py rows)", role: "worker" },
  "P.w.call(js)": { phase: "worker", label: "· callJs (js↔py span ⊇ py rows)", role: "worker" },
  "2b.w.q.boot": { phase: "worker", label: "· bootWait (cold pyodide)", role: "worker" },
  "P.w.q.boot": { phase: "worker", label: "· bootWait (cold pyodide)", role: "worker" },
  "2b.w.q.request": { phase: "worker", label: "· queueWait (transit+evloop)", role: "worker" },
  "P.w.q.request": { phase: "worker", label: "· queueWait (transit+evloop)", role: "worker" },
  "2b.w.q.response": { phase: "worker", label: "· respWait (main evloop)", role: "worker" },
  "P.w.q.response": { phase: "worker", label: "· respWait (main evloop)", role: "worker" },
  "2b.w.rpc+queue": { phase: "worker", label: "· rpcOverhead (marshal+sched)", role: "worker" },
  "P.w.rpc+queue": { phase: "worker", label: "· rpcOverhead (marshal+sched)", role: "worker" },

  // ── apply → commit · main-thread ─────────────────────────────────────
  // P1 (TM-317): footprint chunks warmed concurrently with the worker compute
  // so `materialize.fetchBaseline` below hits a resident chunk (sub-ms clone)
  // instead of a cold IO await. This await is normally already settled by the
  // time the worker mask returns, so its recorded cost should be ~0.
  "P1.warm(io)": { phase: "apply", label: "· prefetch.warm (await, overlapped)", role: "io" },
  "apply.total(cpu)": { phase: "apply", label: "Σ withBatch (writeRegion+commit)", role: "container" },
  "overlay.paint.apply.writeRegion": { phase: "apply", label: "· writeRegion", role: "cpu" },
  "overlay.paint.materialize.clones": { phase: "apply", label: "· materialize.clones", role: "cpu" },
  "overlay.paint.materialize.fetchBaseline": { phase: "apply", label: "· materialize.fetchBaseline (await)", role: "io" },
  "5.mirror.fuse(cpu)": { phase: "apply", label: "mirror.fuse", role: "cpu" },
  "5.mirror.read(io)": { phase: "apply", label: "mirror.read (await)", role: "io" },

  // ── render · main-thread ─────────────────────────────────────────────
  "6.gpu.upload(value)": { phase: "render", label: "gpu.upload value", role: "render" },
  "6.gpu.upload(mask)": { phase: "render", label: "gpu.upload mask", role: "render" },
  "mt.frameDraw": { phase: "render", label: "frameDraw (render loop)", role: "render" },

  // ── health ───────────────────────────────────────────────────────────
  "mt.longtask(>50ms)": { phase: "health", label: "longtask >50ms (un-instrumented stalls)", role: "stall" },
};

function classify(name: string): BucketMeta {
  const m = BUCKET_META[name];
  if (m !== undefined) return m;
  return { phase: "other", label: name, role: "cpu" };
}

class PaintProfiler {
  private _enabled = false;
  private longTaskObserver: PerformanceObserver | undefined;

  get enabled(): boolean {
    return this._enabled;
  }

  /**
   * Toggling on also starts a `longtask` PerformanceObserver: any main-thread
   * task > 50 ms during a stroke lands in the `mt.longtask(>50ms)` bucket.
   * This is the catch-all for un-instrumented main-thread stalls (GC, layout,
   * render frames, third-party work) that delay worker-response delivery —
   * compare its total against `2b.w.q.response`.
   */
  set enabled(value: boolean) {
    this._enabled = value;
    if (value) this.startLongTaskObserver();
    else this.stopLongTaskObserver();
  }

  private startLongTaskObserver(): void {
    if (this.longTaskObserver !== undefined) return;
    if (typeof PerformanceObserver === "undefined") return;
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          this.record("mt.longtask(>50ms)", entry.duration);
        }
      });
      observer.observe({ type: "longtask", buffered: false });
      this.longTaskObserver = observer;
    } catch {
      // 'longtask' unsupported in this browser — diagnostics only, ignore.
    }
  }

  private stopLongTaskObserver(): void {
    this.longTaskObserver?.disconnect();
    this.longTaskObserver = undefined;
  }

  private readonly buckets = new Map<string, Bucket>();
  private readonly counters = new Map<string, number>();
  private context: Record<string, string | number | boolean> = {};
  private flushHandle: ReturnType<typeof setTimeout> | undefined;

  /** Most recent stroke summary as copyable plain text. */
  lastSummary = "";
  /** All stroke summaries this session (capped), for `copy(...dump())`. */
  private readonly summaries: string[] = [];

  /**
   * Attach descriptive params for the current stroke window (brush size, mask
   * settings, dtypes, path…). Merged; printed in the summary so each block is
   * self-describing. No-op when disabled.
   */
  setContext(ctx: Record<string, string | number | boolean>): void {
    if (!this.enabled) return;
    Object.assign(this.context, ctx);
  }

  /** Record a phase duration (ms). Schedules a debounced summary flush. */
  record(name: string, ms: number): void {
    let b = this.buckets.get(name);
    if (b === undefined) {
      b = { totalMs: 0, calls: 0, maxMs: 0 };
      this.buckets.set(name, b);
    }
    b.totalMs += ms;
    b.calls++;
    if (ms > b.maxMs) b.maxMs = ms;
    this.scheduleFlush();
  }

  /** Accumulate a count (e.g. voxels touched) for the current stroke window. */
  count(name: string, n: number): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + n);
  }

  /** Time a synchronous block. Returns `fn()` directly when disabled. */
  time<T>(name: string, fn: () => T): T {
    if (!this.enabled) return fn();
    const t0 = performance.now();
    try {
      return fn();
    } finally {
      this.record(name, performance.now() - t0);
    }
  }

  /** Time an async block (e.g. the worker round-trip). */
  async timeAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
    if (!this.enabled) return fn();
    const t0 = performance.now();
    try {
      return await fn();
    } finally {
      this.record(name, performance.now() - t0);
    }
  }

  private scheduleFlush(): void {
    if (this.flushHandle !== undefined) clearTimeout(this.flushHandle);
    // ~400ms of inactivity ≈ "stroke ended" → print one summary per stroke.
    this.flushHandle = setTimeout(() => this.flush(), 400);
  }

  /**
   * Which masked compute path ran, inferred from the buckets present:
   * `P.*` = TM-317 whole-pipeline-in-pyodide; `2b.*` = the old split
   * (main-thread mask + worker morphology). Both can appear in one stroke if the
   * worker went warm mid-stroke → `MIXED`.
   */
  private detectPath(): string {
    let pyodide = false;
    let split = false;
    for (const name of this.buckets.keys()) {
      if (name.startsWith("P.")) pyodide = true;
      else if (name.startsWith("2b.")) split = true;
    }
    if (pyodide && split) return "MIXED (worker went warm mid-stroke)";
    if (pyodide) return "PYODIDE-PIPELINE (whole compute in worker)";
    if (split) return "SPLIT (main-thread mask + worker morphology)";
    return "no-mask / unmasked";
  }

  /** Build the accumulated summary, print it, and clear the window. */
  flush(): void {
    this.flushHandle = undefined;
    if (this.buckets.size === 0) return;
    const text = this.renderSummary();
    this.lastSummary = text;
    this.summaries.push(text);
    if (this.summaries.length > 50) this.summaries.shift();
    // Single console.log so the whole block selects/copies as plain text.
    console.log(
      `${text}\n— copy this block, or run copy(__paintProfiler.dump()) for all strokes —`,
    );
    this.buckets.clear();
    this.counters.clear();
    this.context = {};
  }

  /**
   * Render the currently-accumulated window as the same sectioned plain-text
   * block `flush()` prints (params · BLOCKS-UI headline · ①..⑥ phase tables ·
   * counts · legend), WITHOUT the interactive "copy this block" hint and WITHOUT
   * clearing. For programmatic capture (the edit-paint benchmark): `resetWindow()`
   * → drive one stroke → `renderSummary()`. Returns "" when nothing was recorded.
   */
  renderSummary(): string {
    if (this.buckets.size === 0) return "";

    // Group recorded buckets by phase and tally the roles.
    const byPhase = new Map<Phase, Array<[string, Bucket, BucketMeta]>>();
    let cpuCompute = 0;
    let cpuApply = 0;
    let renderMs = 0;
    let offThread = 0;
    let ioMs = 0;
    for (const [name, b] of this.buckets) {
      const meta = classify(name);
      const list = byPhase.get(meta.phase);
      if (list === undefined) byPhase.set(meta.phase, [[name, b, meta]]);
      else list.push([name, b, meta]);
      if (meta.role === "cpu") {
        if (meta.phase === "compute") cpuCompute += b.totalMs;
        else if (meta.phase === "apply") cpuApply += b.totalMs;
      } else if (meta.role === "render") {
        renderMs += b.totalMs;
      } else if (meta.role === "container" && meta.phase === "worker") {
        offThread += b.totalMs;
      } else if (meta.role === "io") {
        ioMs += b.totalMs;
      }
    }
    const blocksUi = cpuCompute + cpuApply;
    // Per-segment wall. Prefer the compute-only stroke timer (`0.stroke(total)`,
    // recorded inside `applyBrushStroke`); the masked worker route
    // (`worker-mask`) bypasses `applyBrushStroke`, so fall back to the full
    // per-segment span `4.handleInput(total)` (compute + apply, recorded for
    // every segment in the pointer bridge). Without the fallback the headline
    // `…/seg` line vanishes on the worker path. Mirrors `edit_paint_bench`.
    const stroke =
      this.buckets.get("0.stroke(total)") ??
      this.buckets.get("4.handleInput(total)");
    const segs = stroke ? stroke.calls : 0;
    const wallTotal = stroke ? stroke.totalMs : undefined;
    const perSeg = wallTotal !== undefined && segs > 0 ? wallTotal / segs : undefined;

    const reinit = this.counters.get("morphology.workerReinit") ?? 0;
    const heap = this.counters.get("morphology.heapPressure") ?? 0;
    const warn =
      reinit > 0 || heap > 0
        ? `   ⚠ worker reinit×${reinit}, heapPressure×${heap}`
        : "";

    const lines: string[] = [];
    lines.push(`[paint-profile] stroke — path: ${this.detectPath()}${warn}`);
    if (Object.keys(this.context).length > 0) {
      lines.push(
        "params: " +
          Object.entries(this.context)
            .map(([k, v]) => `${k}=${v}`)
            .join("  "),
      );
    }
    lines.push("");
    // Headline: separate what BLOCKS the UI from off-thread + render + awaits.
    if (wallTotal !== undefined) {
      lines.push(
        `wall ≈ ${f1(wallTotal)} ms` +
          (perSeg !== undefined ? ` / ${segs} seg (${f1(perSeg)} ms/seg)` : ""),
      );
    }
    lines.push(
      `BLOCKS UI ≈ ${f1(blocksUi)} ms` +
        `  =  compute ${f1(cpuCompute)} + apply ${f1(cpuApply)}` +
        `   (main-thread CPU that stalls the brush)`,
    );
    lines.push(
      `off-thread ≈ ${f1(offThread)} ms worker` +
        `   render ≈ ${f1(renderMs)} ms   awaits ≈ ${f1(ioMs)} ms (non-blocking)`,
    );
    lines.push("");

    // Per-phase tables, containers first then leaves by descending total.
    const header = ["phase", "total ms", "calls", "avg ms", "max ms"];
    for (const phase of PHASE_ORDER) {
      const list = byPhase.get(phase);
      if (list === undefined || list.length === 0) continue;
      list.sort((a, b) => {
        const ca = a[2].role === "container" ? 0 : 1;
        const cb = b[2].role === "container" ? 0 : 1;
        if (ca !== cb) return ca - cb;
        return b[1].totalMs - a[1].totalMs;
      });
      lines.push(PHASE_TITLE[phase]);
      const rows = list.map(([, b, meta]) => [
        meta.label,
        f1(b.totalMs),
        String(b.calls),
        round(b.totalMs / b.calls, 2).toFixed(2),
        round(b.maxMs, 2).toFixed(2),
      ]);
      lines.push(...formatTable(header, rows));
      lines.push("");
    }

    // Counters, split into labelled lines.
    this.pushCounterLine(lines, "voxels ", [
      "voxels.footprintBbox",
      "voxels.painted",
      "voxels.morphInput",
      "voxels.morphInputFull",
    ]);
    this.pushCounterLine(lines, "commit ", [
      "overlay.paint.apply.chunks",
      "mirror.syncs",
      "segments.coalescedVia",
    ]);
    this.pushGpuLine(lines);

    lines.push("");
    lines.push(
      "legend: BLOCKS-UI = main-thread CPU (compute+apply leaves) · " +
        "off-thread = worker round-trip (overlaps UI, single-flight gated) · " +
        "awaits = io yields · ‘Σ’ rows are containers (not summed)",
    );

    return lines.join("\n").replace(/\n+$/, "");
  }

  /** Append a labelled counter line for the given keys that are present. */
  private pushCounterLine(
    lines: string[],
    label: string,
    keys: string[],
  ): void {
    const parts: string[] = [];
    for (const key of keys) {
      const v = this.counters.get(key);
      if (v === undefined) continue;
      const short = key.slice(key.lastIndexOf(".") + 1);
      parts.push(`${short}=${v.toLocaleString("en-US")}`);
    }
    if (parts.length > 0) lines.push(`${label}: ${parts.join("  ")}`);
  }

  /** GPU counters condensed: total bytes (MB) + upload count (full+sub). */
  private pushGpuLine(lines: string[]): void {
    const bytes = this.counters.get("gpu.uploadBytes");
    if (bytes === undefined) return;
    let uploads = 0;
    for (const [k, v] of this.counters) {
      if (k.startsWith("gpu.upload.")) uploads += v;
    }
    lines.push(
      `gpu    : uploadBytes=${(bytes / (1024 * 1024)).toFixed(1)} MB  uploads=${uploads}`,
    );
  }

  /** All recorded stroke summaries joined — use `copy(__paintProfiler.dump())`. */
  dump(): string {
    return this.summaries.join("\n\n");
  }

  /** Discard recorded summaries. */
  clear(): void {
    this.summaries.length = 0;
    this.lastSummary = "";
  }

  /**
   * Snapshot the currently-accumulated buckets + counters WITHOUT clearing or
   * printing. For programmatic benchmark reads (e.g. the edit-paint benchmark
   * harness): `resetWindow()` → drive one stroke → `snapshot()`. Returns plain
   * objects so it serializes cleanly across `page.evaluate`.
   */
  snapshot(): {
    buckets: Record<string, { totalMs: number; calls: number; maxMs: number }>;
    counters: Record<string, number>;
  } {
    const buckets: Record<
      string,
      { totalMs: number; calls: number; maxMs: number }
    > = {};
    for (const [name, b] of this.buckets) {
      buckets[name] = { totalMs: b.totalMs, calls: b.calls, maxMs: b.maxMs };
    }
    const counters: Record<string, number> = {};
    for (const [name, v] of this.counters) counters[name] = v;
    return { buckets, counters };
  }

  /**
   * Clear the live accumulation window (buckets + counters + context) and cancel
   * the pending auto-flush, WITHOUT printing a summary. Lets a benchmark isolate
   * one stroke's measurements from the next.
   */
  resetWindow(): void {
    if (this.flushHandle !== undefined) {
      clearTimeout(this.flushHandle);
      this.flushHandle = undefined;
    }
    this.buckets.clear();
    this.counters.clear();
    this.context = {};
  }
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** One-decimal fixed string (the common case in the summary). */
function f1(n: number): string {
  return round(n, 1).toFixed(1);
}

/**
 * Render a fixed-width text table: phase left-aligned, numeric columns
 * right-aligned. Plain text so it copies cleanly into a report or chat.
 */
function formatTable(header: string[], rows: string[][]): string[] {
  const widths = header.map((h, c) =>
    Math.max(h.length, ...rows.map((r) => r[c].length)),
  );
  const fmt = (cells: string[]): string =>
    cells
      .map((cell, c) =>
        c === 0 ? cell.padEnd(widths[c]) : cell.padStart(widths[c]),
      )
      .join("  ");
  return [fmt(header), ...rows.map(fmt)];
}

/**
 * Process-wide singleton, also exposed on `globalThis.__paintProfiler` so it can
 * be toggled from the browser console without a rebuild.
 */
export const paintProfiler = new PaintProfiler();
(globalThis as unknown as { __paintProfiler?: PaintProfiler }).__paintProfiler =
  paintProfiler;
