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
 * Playwright config for the edit-session PAINT BENCHMARK (separate from the
 * example-project screenshot harness).
 *
 * Portal-style setup (`zetta-ai-portal/e2e`): serve the **built prod bundle**
 * via a dedicated static server (`tests/editing/bench/serve_dist.mjs`) with a
 * FRESH server each run (`reuseExistingServer: false`) — NO webpack dev-server,
 * so there is no HMR recompile/reload mid-run (the stale-bundle problem). The
 * static server sets COOP/COEP so `crossOriginIsolated` is true (SAB + pyodide).
 *
 *   npm run bench:paint           # builds the prod bundle, then runs this
 *
 * The build must exist before the server starts — `bench:paint` builds first.
 * ⚠ Needs access to the `gs://` buckets in the spec's ngState. Benchmark, not a
 * gating test. WebGL flags / timeouts may need tuning per host.
 */

import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.BENCH_PORT ?? 9777);

export default defineConfig({
  testDir: "tests/editing/bench",
  testMatch: /edit_paint_bench\.spec\.ts/,
  // pyodide boot + 18 strokes at up to r=512 — generous.
  timeout: 10 * 60 * 1000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    browserName: "chromium",
    headless: true,
    launchOptions: {
      // Software WebGL2 in headless chromium. TUNE per host/CI if the canvas
      // stays black or WebGL2 is unavailable.
      args: [
        "--use-gl=angle",
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
        "--ignore-gpu-blocklist",
        "--enable-features=Vulkan",
      ],
    },
  },
  webServer: {
    // Serve the prebuilt `dist/client` — fresh each run, no HMR.
    command: "node tests/editing/bench/serve_dist.mjs",
    url: `http://localhost:${PORT}`,
    env: { BENCH_PORT: String(PORT) },
    reuseExistingServer: false,
    timeout: 60 * 1000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
