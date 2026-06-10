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

class PaintProfiler {
  enabled = false;
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

  /** Build the accumulated summary as one copyable plain-text block. */
  flush(): void {
    this.flushHandle = undefined;
    if (this.buckets.size === 0) return;

    // Sort by bucket name (numeric prefixes order the phases 0,1a,1b,2a…).
    const names = [...this.buckets.keys()].sort();
    let cpuTotal = 0;
    const stroke = this.buckets.get("0.stroke(total)");
    for (const [name, b] of this.buckets) {
      if (name.includes("cpu")) cpuTotal += b.totalMs;
    }

    const rows = names.map((name) => {
      const b = this.buckets.get(name)!;
      return [
        name,
        round(b.totalMs, 1).toFixed(1),
        String(b.calls),
        round(b.totalMs / b.calls, 3).toFixed(3),
        round(b.maxMs, 2).toFixed(2),
      ];
    });
    const header = ["phase", "total ms", "calls", "avg ms", "max ms"];

    const lines: string[] = [];
    lines.push("[paint-profile] stroke summary");
    if (Object.keys(this.context).length > 0) {
      lines.push(
        "params: " +
          Object.entries(this.context)
            .map(([k, v]) => `${k}=${v}`)
            .join("  "),
      );
    }
    const wall = stroke ? `${round(stroke.totalMs, 1).toFixed(1)}` : "?";
    const segments = stroke ? stroke.calls : 0;
    lines.push(
      `main-thread CPU ≈ ${round(cpuTotal, 1).toFixed(1)} ms   ` +
        `wall ≈ ${wall} ms   segments=${segments}`,
    );
    lines.push("");
    lines.push(...formatTable(header, rows));
    if (this.counters.size > 0) {
      lines.push("");
      lines.push(
        "voxels:  " +
          [...this.counters.entries()]
            .map(([k, v]) => `${k}=${v.toLocaleString("en-US")}`)
            .join("   "),
      );
    }

    const text = lines.join("\n");
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

  /** All recorded stroke summaries joined — use `copy(__paintProfiler.dump())`. */
  dump(): string {
    return this.summaries.join("\n\n");
  }

  /** Discard recorded summaries. */
  clear(): void {
    this.summaries.length = 0;
    this.lastSummary = "";
  }
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
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
