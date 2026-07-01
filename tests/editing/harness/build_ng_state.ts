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
 * `buildNgState` (TM-331, phase 2) — assemble an ngState from a declarative
 * scenario + the generated fixtures index, replacing the bench's hard-coded
 * `VIEWER_STATE`. A scenario names which fixtures are the image / target, which
 * are writable, and the edit region; the builder emits the layers + the
 * `editSession` block that auto-opens the session.
 *
 * Pure (no I/O): callers pass the parsed `fixtures.json` index and, optionally,
 * a `sourceFor` that rewrites each fixture's data-source URL (identity ⇒ the
 * `precomputed://gs://…` source served by the local fake-gcs; or point it at a
 * test-data HTTP server). This keeps it unit-testable and lets the SAME scenario
 * run against fake-gcs or http by swapping one function.
 */

export type Vec3 = readonly [number, number, number];

export interface FixtureInfo {
  readonly id: string;
  readonly kind: "image" | "segmentation";
  readonly dtype: string;
  readonly encoding: string;
  readonly chunk: Vec3;
  readonly offset: Vec3;
  readonly size: Vec3;
  readonly resolutions: readonly Vec3[];
  /** `precomputed://gs://<bucket>/<id>` as written by `generate.py`. */
  readonly source: string;
}

export interface FixturesIndex {
  readonly bucket: string;
  readonly fixtures: readonly FixtureInfo[];
}

export interface ScenarioLayer {
  readonly fixtureId: string;
  readonly role: "image" | "target";
  readonly writable: boolean;
  /** NG layer name; defaults to the fixture id. */
  readonly name?: string;
}

export interface Scenario {
  readonly name: string;
  readonly layers: readonly ScenarioLayer[];
  /**
   * Edit region size in target-resolution voxels. `lo` is the target fixture's
   * voxelOffset; `hi = lo + regionSize`. Defaults to the target's full size.
   */
  readonly regionSize?: Vec3;
  /** Override the auto-derived `editSession.tooling` block. */
  readonly tooling?: Record<string, unknown>;
  /**
   * NG `crossSectionScale` (voxels per pixel-ish: smaller = more zoomed in).
   * Defaults to framing the in-plane region across the viewport so a stamp at
   * the panel centre is visible — the small fixtures would otherwise be a dot.
   */
  readonly crossSectionScale?: number;
}

export interface BuildOptions {
  /** Map a fixture to its NG `source` URL. Default: the fixture's gs:// source. */
  readonly sourceFor?: (fixture: FixtureInfo) => string;
}

/** `[16,16,40]` → `"16x16x40"` (the edit-session resolution key form). */
export function formatResolution(res: Vec3): string {
  return res.join("x");
}

/** nm → the `[meters, "m"]` pair NG `dimensions` use. */
function nmToDimension(nm: number): [number, string] {
  return [nm * 1e-9, "m"];
}

function dimensionsFor(res: Vec3): {
  x: [number, string];
  y: [number, string];
  z: [number, string];
} {
  return {
    x: nmToDimension(res[0]),
    y: nmToDimension(res[1]),
    z: nmToDimension(res[2]),
  };
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function resolveLayer(
  index: FixturesIndex,
  scenarioLayer: ScenarioLayer,
): FixtureInfo {
  const fixture = index.fixtures.find((f) => f.id === scenarioLayer.fixtureId);
  if (fixture === undefined) {
    throw new Error(
      `buildNgState: fixture "${scenarioLayer.fixtureId}" not in the index ` +
        `(have: ${index.fixtures.map((f) => f.id).join(", ")})`,
    );
  }
  if (scenarioLayer.role === "image" && fixture.kind !== "image") {
    throw new Error(
      `buildNgState: layer "${fixture.id}" is role "image" but fixture kind is "${fixture.kind}"`,
    );
  }
  return fixture;
}

/** Assemble the ngState (with auto-opening `editSession`) for a scenario. */
export function buildNgState(
  scenario: Scenario,
  index: FixturesIndex,
  options: BuildOptions = {},
): Record<string, unknown> {
  if (scenario.layers.length === 0) {
    throw new Error(`buildNgState: scenario "${scenario.name}" has no layers`);
  }
  const sourceFor = options.sourceFor ?? ((f: FixtureInfo) => f.source);

  const resolved = scenario.layers.map((sl) => ({
    scenario: sl,
    fixture: resolveLayer(index, sl),
    name: sl.name ?? sl.fixtureId,
  }));

  const target = resolved.find((r) => r.scenario.role === "target");
  if (target === undefined) {
    throw new Error(
      `buildNgState: scenario "${scenario.name}" has no target layer`,
    );
  }
  const targetRes = target.fixture.resolutions[0];
  const regionLo = target.fixture.offset;
  const regionSize = scenario.regionSize ?? target.fixture.size;
  const regionHi = add(regionLo, regionSize);
  const dimensions = dimensionsFor(targetRes);

  const firstWritable = resolved.find((r) => r.scenario.writable);
  const imageLayer = resolved.find((r) => r.scenario.role === "image");

  const layers = resolved.map((r) => {
    const base = {
      type: r.fixture.kind === "image" ? "image" : "segmentation",
      source: sourceFor(r.fixture),
      tab: "source",
      name: r.name,
    };
    return r.fixture.kind === "image" ? base : { ...base, segments: [] };
  });

  const tooling =
    scenario.tooling ?? defaultTooling(target.name, targetRes, imageLayer);

  // Frame the in-plane region across ~the viewport so a centre stamp is visible.
  const crossSectionScale =
    scenario.crossSectionScale ??
    Math.max(0.05, Math.max(regionSize[0], regionSize[1]) / 600);

  return {
    dimensions,
    position: [
      regionLo[0] + regionSize[0] / 2,
      regionLo[1] + regionSize[1] / 2,
      regionLo[2] + regionSize[2] / 2,
    ],
    crossSectionScale,
    layout: "xy",
    layers,
    selectedLayer: {
      visible: true,
      layer: (firstWritable ?? target).name,
    },
    editSession: {
      layers: resolved.map((r) => ({
        layerId: r.name,
        resolutions: r.fixture.resolutions.map(formatResolution),
        writable: r.scenario.writable,
      })),
      region: { lo: regionLo, hi: regionHi, dimensions },
      tooling,
    },
  };
}

function defaultTooling(
  targetName: string,
  targetRes: Vec3,
  imageLayer: { name: string; fixture: FixtureInfo } | undefined,
): Record<string, unknown> {
  const painting: Record<string, unknown> = {
    targetLayerId: targetName,
    targetResolution: formatResolution(targetRes),
    radius: 8,
    activeValue: { t: "b", v: "1" },
    eraseValue: { t: "b", v: "0" },
  };
  if (imageLayer !== undefined) {
    painting.mask = {
      imageLayerId: imageLayer.name,
      imageResolution: formatResolution(imageLayer.fixture.resolutions[0]),
      thresholdLow: 0,
      thresholdHigh: 255,
      minComponentSize: 0,
      binaryClosing: 0,
      filterComponentsFirst: false,
    };
  }
  return { activeToolId: "painting.brush", painting };
}
