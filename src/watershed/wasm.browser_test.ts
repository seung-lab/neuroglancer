/**
 * @license
 * Copyright 2026 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { runWatershedWasm } from "#src/watershed/wasm.js";

interface NativeFixture {
  name: string;
  dims: number[];
  affinities: number[];
  high: number;
  low: number;
  size: number;
  dust: number;
  labels: number[];
}

let fixtures: NativeFixture[];
let agglomerationFixtures: (NativeFixture & { agg_threshold: number | null })[];
beforeAll(async () => {
  const response = await fetch(
    new URL("./testdata/native-reference.json", import.meta.url),
  );
  expect(response.ok).toBe(true);
  fixtures = await response.json();
  const agglomerationResponse = await fetch(
    new URL("./testdata/agglomeration-native-reference.json", import.meta.url),
  );
  expect(agglomerationResponse.ok).toBe(true);
  agglomerationFixtures = await agglomerationResponse.json();
});

const keep = {
  highThreshold: 1,
  lowThreshold: 0,
  sizeThreshold: 0,
  dustThreshold: 0,
};

describe("standalone Abiss watershed WASM", () => {
  it("matches exact native labels on 80 diverse fixtures without modifying inputs", async () => {
    expect(fixtures).toHaveLength(80);
    for (const f of fixtures) {
      const input = Float32Array.from(f.affinities);
      const output = await runWatershedWasm(input, f.dims, {
        highThreshold: f.high,
        lowThreshold: f.low,
        sizeThreshold: f.size,
        dustThreshold: f.dust,
      });
      expect(Array.from(output), f.name).toEqual(f.labels);
      expect(Array.from(input), f.name).toEqual(
        Array.from(Float32Array.from(f.affinities)),
      );
    }
  });

  it("matches native agglomeration, cleanup ordering, and disabled parity fixtures", async () => {
    expect(agglomerationFixtures).toHaveLength(31);
    for (const f of agglomerationFixtures) {
      const input = Float32Array.from(f.affinities);
      const before = input.slice();
      const output = await runWatershedWasm(input, f.dims, {
        highThreshold: f.high,
        lowThreshold: f.low,
        sizeThreshold: f.size,
        dustThreshold: f.dust,
        ...(f.agg_threshold === null ? {} : { aggThreshold: f.agg_threshold }),
      });
      expect(Array.from(output), f.name).toEqual(f.labels);
      expect(input, f.name).toEqual(before);
    }
  });

  it.each([0, 1, 2])(
    "optionally agglomerates negative-axis %s basins with a strict threshold",
    async (axis) => {
      const shape = [1, 1, 1];
      shape[axis] = 5;
      const input = new Float32Array(3 * 5).fill(1);
      input.set([0, 1, 0.25, 1, 1], axis * 5);
      const before = input.slice();
      const separate = [1, 1, 2, 2, 2];
      expect(Array.from(await runWatershedWasm(input, shape, keep))).toEqual(
        separate,
      );
      for (const aggThreshold of [0.25, 1]) {
        expect(
          Array.from(
            await runWatershedWasm(input, shape, { ...keep, aggThreshold }),
          ),
        ).toEqual(separate);
      }
      for (const aggThreshold of [0, 0.2]) {
        expect(
          Array.from(
            await runWatershedWasm(input, shape, { ...keep, aggThreshold }),
          ),
        ).toEqual([1, 1, 1, 1, 1]);
      }
      expect(input).toEqual(before);
      // Enabling the new export must not alter subsequent disabled calls.
      expect(Array.from(await runWatershedWasm(input, shape, keep))).toEqual(
        separate,
      );
    },
  );

  it("uses a contact-area mean rather than the maximum boundary affinity", async () => {
    const input = new Float32Array(3 * 8).fill(1);
    input[2] = 0.25;
    input[6] = 0.75;
    const shape = [4, 2, 1];
    const separate = [1, 1, 2, 2, 1, 1, 2, 2];
    expect(Array.from(await runWatershedWasm(input, shape, keep))).toEqual(
      separate,
    );
    for (const aggThreshold of [0.5, 0.6]) {
      expect(
        Array.from(
          await runWatershedWasm(input, shape, { ...keep, aggThreshold }),
        ),
      ).toEqual(separate);
    }
    expect(
      Array.from(
        await runWatershedWasm(input, shape, { ...keep, aggThreshold: 0.49 }),
      ),
    ).toEqual(new Array(8).fill(1));
  });

  it("retains weak and zero contacts in area-weighted shared-neighbor updates", async () => {
    const input = new Float32Array(3 * 16).fill(1);
    for (const [row, value] of [0.9, 0.6, 0.6, 0].entries())
      input[row * 4 + 2] = value;
    input[16 + 4 + 2] = input[16 + 4 + 3] = 0.8;
    const shape = [4, 4, 1];
    // A spans the left two columns, B the top-right pair, C the other right
    // pairs. A-B has mean .9. After merging, (A+B)-C must have mean
    // (.6 + .6 + 0 + .8 + .8) / 5 = .56, not an unweighted mean or a max.
    expect(Array.from(await runWatershedWasm(input, shape, keep))).toEqual([
      1, 1, 2, 2, 1, 1, 3, 3, 1, 1, 3, 3, 1, 1, 3, 3,
    ]);
    expect(
      Array.from(
        await runWatershedWasm(input, shape, { ...keep, aggThreshold: 0.58 }),
      ),
    ).toEqual([1, 1, 1, 1, 1, 1, 3, 3, 1, 1, 3, 3, 1, 1, 3, 3]);
    expect(
      Array.from(
        await runWatershedWasm(input, shape, { ...keep, aggThreshold: 0.55 }),
      ),
    ).toEqual(new Array(16).fill(1));
  });

  it("never agglomerates through masked background, even at threshold zero", async () => {
    const input = new Float32Array(4 * 5).fill(1);
    input.set([0, 0, 0.5, 0, 0], 15);
    const before = input.slice();
    expect(
      Array.from(
        await runWatershedWasm(input, [5, 1, 1], {
          ...keep,
          maskThreshold: 0.5,
          aggThreshold: 0,
        }),
      ),
    ).toEqual([1, 1, 0, 2, 2]);
    expect(input).toEqual(before);
  });

  it.each([NaN, Infinity, -0.1, 1.01])(
    "rejects invalid agglomeration threshold %s before native execution",
    async (aggThreshold) => {
      await expect(
        runWatershedWasm(new Float32Array(3 * 5).fill(1), [5, 1, 1], {
          ...keep,
          aggThreshold,
        }),
      ).rejects.toThrow("agglomeration threshold");
      expect(
        Array.from(
          await runWatershedWasm(
            new Float32Array(3 * 5).fill(1),
            [5, 1, 1],
            keep,
          ),
        ),
      ).toEqual([1, 1, 1, 1, 1]);
    },
  );

  it.each([NaN, Infinity, -0.1, 1.01])(
    "surfaces invalid native affinity %s and recovers on the same instance",
    async (invalid) => {
      const input = new Float32Array(3 * 24).fill(1);
      input[5] = invalid;
      await expect(runWatershedWasm(input, [4, 3, 2], keep)).rejects.toThrow(
        "status 1",
      );
      input[5] = 1;
      const output = await runWatershedWasm(input, [4, 3, 2], keep);
      expect(Array.from(output)).toEqual(new Array(24).fill(1));
    },
  );

  it.each([0, 1, 2])(
    "masks both endpoints of negative-axis %s edges using strict thresholds",
    async (axis) => {
      const shape = [1, 1, 1];
      shape[axis] = 5;
      const input = new Float32Array(4 * 5).fill(1);
      input.set([0.25, 0.25, 0.5, 0.25, 0.25], 3 * 5);
      const before = input.slice();
      const output = await runWatershedWasm(input, shape, {
        ...keep,
        maskThreshold: 0.5,
      });
      expect(Array.from(output)).toEqual([1, 1, 0, 2, 2]);
      expect(input).toEqual(before);
      const manual = new Float32Array(3 * 5).fill(1);
      for (let c = 0; c < 3; ++c) manual[c * 5 + 2] = 0;
      manual[axis * 5 + 3] = 0;
      expect(output).toEqual(await runWatershedWasm(manual, shape, keep));
    },
  );

  it("uses the XYZ strides of a full three-dimensional mask", async () => {
    const input = new Float32Array(4 * 27).fill(1);
    input.fill(0, 3 * 27);
    input[3 * 27 + 13] = 1;
    const output = await runWatershedWasm(input, [3, 3, 3], {
      ...keep,
      maskThreshold: 0.3,
    });
    const expected = new Uint32Array(27).fill(1);
    expected[13] = 0;
    expect(output).toEqual(expected);
    const manual = new Float32Array(3 * 27).fill(1);
    manual[13] = manual[27 + 13] = manual[54 + 13] = 0;
    manual[14] = manual[27 + 16] = manual[54 + 22] = 0;
    expect(output).toEqual(await runWatershedWasm(manual, [3, 3, 3], keep));
  });

  it("does not wrap masks across the low domain face and can mask the whole domain", async () => {
    const input = new Float32Array(4 * 5).fill(1);
    input.set([0, 0, 0, 0, 1], 15);
    expect(
      Array.from(
        await runWatershedWasm(input, [5, 1, 1], { ...keep, maskThreshold: 1 }),
      ),
    ).toEqual([1, 1, 1, 1, 0]);
    expect(
      Array.from(
        await runWatershedWasm(input, [5, 1, 1], { ...keep, maskThreshold: 0 }),
      ),
    ).toEqual([0, 0, 0, 0, 0]);
  });

  it.each([NaN, Infinity, -0.1, 1.01])(
    "rejects invalid mask values %s without poisoning the instance",
    async (invalid) => {
      const input = new Float32Array(4 * 5).fill(1);
      input.fill(0, 15);
      input[17] = invalid;
      await expect(
        runWatershedWasm(input, [5, 1, 1], { ...keep, maskThreshold: 0.3 }),
      ).rejects.toThrow("mask values");
      input[17] = 0;
      expect(
        Array.from(
          await runWatershedWasm(input, [5, 1, 1], {
            ...keep,
            maskThreshold: 0.3,
          }),
        ),
      ).toEqual([1, 1, 1, 1, 1]);
    },
  );

  it.each([NaN, Infinity, -0.1, 1.01])(
    "does not conceal invalid affinities %s inside masked voxels",
    async (invalid) => {
      const input = new Float32Array(4 * 5).fill(1);
      input[2] = invalid;
      await expect(
        runWatershedWasm(input, [5, 1, 1], { ...keep, maskThreshold: 0.3 }),
      ).rejects.toThrow("before masking");
    },
  );

  it("copies stable output even when a later call grows WASM memory", async () => {
    const first = await runWatershedWasm(
      new Float32Array(3 * 24).fill(1),
      [4, 3, 2],
      keep,
    );
    const n = 96 ** 3;
    const output = await runWatershedWasm(
      new Float32Array(3 * n).fill(1),
      [96, 96, 96],
      keep,
    );
    expect(output.length).toBe(n);
    expect(output.every((x) => x === 1)).toBe(true);
    expect(Array.from(first)).toEqual(new Array(24).fill(1));
    expect(first.buffer.byteLength).toBe(24 * 4);
  }, 30000);

  it("serializes concurrent invocations on one module without sharing outputs", async () => {
    const inputs = [0, 1, 0, 1].map((v) => new Float32Array(3 * 24).fill(v));
    const outputs = await Promise.all(
      inputs.map((input) => runWatershedWasm(input, [4, 3, 2], keep)),
    );
    outputs.forEach((output, i) => {
      expect(Array.from(output)).toEqual(new Array(24).fill(i % 2));
      expect(output.buffer).not.toBe(inputs[i].buffer);
    });
  });

  it("keeps concurrent enabled and disabled calls independent", async () => {
    const input = new Float32Array(3 * 5).fill(1);
    input.set([0, 1, 0.25, 1, 1]);
    const thresholds = [undefined, 0.2, 0.25, 0, 1];
    const outputs = await Promise.all(
      thresholds.map((aggThreshold) =>
        runWatershedWasm(input, [5, 1, 1], {
          ...keep,
          ...(aggThreshold === undefined ? {} : { aggThreshold }),
        }),
      ),
    );
    expect(new Set(outputs.map((output) => output.buffer)).size).toBe(5);
    outputs.forEach((output, i) => {
      expect(Array.from(output)).toEqual(
        i === 1 || i === 3 ? [1, 1, 1, 1, 1] : [1, 1, 2, 2, 2],
      );
      expect(output.buffer).not.toBe(input.buffer);
    });
  });

  it("rejects mismatched buffers and an excessive ROI before entering native code", async () => {
    await expect(
      runWatershedWasm(new Float32Array(2), [1, 1, 1], keep),
    ).rejects.toThrow("planar Float32");
    await expect(
      runWatershedWasm(new Float32Array(15), [5, 1, 1], {
        ...keep,
        maskThreshold: 0.3,
      }),
    ).rejects.toThrow("[4,Z,Y,X]");
    await expect(
      runWatershedWasm(new Float32Array(20), [5, 1, 1], keep),
    ).rejects.toThrow("[3,Z,Y,X]");
    await expect(
      runWatershedWasm(new Float32Array(), [129, 129, 129], keep),
    ).rejects.toThrow("2**21");
  });
});
