/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { Metrics } from "@zettaai/edit-session";

import { paintProfiler } from "#src/editing/tool_runtimes/paint_profiler.js";

/**
 * Adapts the edit-session library's `Metrics` host capability to the paint
 * profiler, so library apply-path timings (`overlay.paint.apply.*`,
 * `overlay.paint.materialize.*`) land in the same copyable stroke summary as the
 * consumer-side compute buckets.
 *
 * Forwards only while the profiler is enabled, so when profiling is off it does
 * no bucket accumulation or flush — the only residual cost is the library's
 * handful of `clock.now()` samples per apply, which is negligible (never
 * per-voxel).
 */
export const paintProfilerMetrics: Metrics = {
  timing: (channel, name, ms) => {
    if (paintProfiler.enabled) paintProfiler.record(`${channel}.${name}`, ms);
  },
  count: (channel, name, n) => {
    if (paintProfiler.enabled) paintProfiler.count(`${channel}.${name}`, n);
  },
};
