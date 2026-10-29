/**
 * @license
 * Copyright 2026 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// @vitest-environment node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_MODEL_BYTES } from "#src/inference/model.js";
import { prepareModelForFp16 } from "#src/inference/precision.js";

const ORIGINAL_SHA =
  "0493be1d38f98236a4782404e616569b5838020a5a892de429d30a5372285860";
const NEW_SHA =
  "2c19eac209030e9f1d3b52d6dfaa72a509291f8644ca0e36fbe22231f2baac3c";
const te = new TextEncoder();
const td = new TextDecoder();
type Bytes = Uint8Array<ArrayBuffer>;
const concat = (...parts: Bytes[]): Bytes =>
  new Uint8Array(Buffer.concat(parts));
function v(n: number): Bytes {
  const out: number[] = [];
  do {
    out.push(n % 128 | (n >= 128 ? 128 : 0));
    n = Math.floor(n / 128);
  } while (n);
  return new Uint8Array(out);
}
const record = (id: number, data: Bytes, wire = 2) =>
  concat(v(id * 8 + wire), ...(wire === 2 ? [v(data.length)] : []), data);
const str = (id: number, s: string) => record(id, te.encode(s));
const int = (id: number, n: number) => record(id, v(n), 0);

// Independent, small test decoder. Intentionally not imported from production.
interface F {
  id: number;
  wire: number;
  data: Bytes;
  raw: Bytes;
}
function decode(b: Bytes): F[] {
  let p = 0;
  const read = () => {
    let value = 0,
      scale = 1,
      x: number;
    do {
      x = b[p++];
      value += (x & 127) * scale;
      scale *= 128;
    } while (x & 128);
    return value;
  };
  const result: F[] = [];
  while (p < b.length) {
    const start = p;
    const tag = read();
    const wire = tag & 7;
    let d = p;
    if (wire === 2) {
      const n = read();
      d = p;
      p += n;
    } else if (wire === 0) read();
    else p += wire === 5 ? 4 : 8;
    result.push({
      id: tag >>> 3,
      wire,
      data: b.slice(d, p),
      raw: b.slice(start, p),
    });
  }
  return result;
}
const get = (b: Bytes, id: number) => decode(b).find((f) => f.id === id)!.data;
const scalar = (b: Bytes, id: number) => get(b, id)[0];
const name = (b: Bytes) => td.decode(get(b, 1));
function info(n: string, count: number): Bytes {
  const dims = [1, 1, 1, 1, count].map((d) => record(1, int(1, d)));
  const tensorType = concat(int(1, 1), record(2, concat(...dims)));
  return concat(
    str(1, n),
    record(2, record(1, tensorType)),
    str(3, "kept documentation"),
  );
}
const unknown = concat(
  int(100, 8123),
  record(101, new Uint8Array([0xff, 0, 0x80])),
  record(102, new Uint8Array(8).fill(0xff), 1),
);
function fixture(values: number[] = [1], packed = false): Bytes {
  const weights = new Uint8Array(values.length * 4);
  const view = new DataView(weights.buffer);
  values.forEach((x, i) => view.setFloat32(i * 4, x, true));
  const tensor = concat(
    int(1, values.length),
    int(2, 1),
    str(8, "w"),
    record(packed ? 4 : 9, weights),
    unknown,
  );
  const shape = concat(
    record(1, v(1)),
    int(2, 7),
    str(8, "shape"),
    record(9, new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])),
  );
  const epsilon = concat(
    str(1, "epsilon"),
    record(2, new Uint8Array([0, 0, 128, 63]), 5),
    int(20, 1),
  );
  const tensorAttr = concat(str(1, "value"), record(5, tensor), int(20, 4));
  const integerAttr = concat(str(1, "value"), record(5, shape), int(20, 4));
  const node = concat(
    str(1, "input"),
    str(1, "w"),
    str(2, "middle"),
    str(3, "add"),
    str(4, "Add"),
    unknown,
  );
  // Epsilon belongs to a normalization schema in real exports. Here it is an
  // intentionally arbitrary scalar attribute to verify wire-preserving copying.
  const relu = concat(
    str(1, "middle"),
    str(2, "output"),
    str(4, "Relu"),
    record(5, epsilon),
  );
  const constant = concat(
    str(2, "constant"),
    str(4, "Constant"),
    record(5, tensorAttr),
  );
  const constantShape = concat(
    str(2, "constantShape"),
    str(4, "Constant"),
    record(5, integerAttr),
  );
  const graph = concat(
    record(1, node),
    record(1, relu),
    record(1, constant),
    record(1, constantShape),
    str(2, "fixture"),
    record(5, tensor),
    record(5, shape),
    record(11, info("input", values.length)),
    record(12, info("output", values.length)),
    record(13, info("middle", values.length)),
    unknown,
  );
  return concat(int(1, 8), record(7, graph), record(8, int(2, 17)), unknown);
}
async function convertFixture(b: Bytes) {
  return new Uint8Array((await prepareModelForFp16(b.buffer)).model);
}
function halfWeights(model: Bytes): number[] {
  const graph = get(model, 7);
  const tensor = decode(graph).find((f) => f.id === 5)!.data;
  const raw = get(tensor, 9);
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  return Array.from({ length: raw.length / 2 }, (_, i) =>
    view.getUint16(i * 2, true),
  );
}

describe("experimental native FP16 preparation", () => {
  it("converts unverified and reserialized models without a fingerprint gate", async () => {
    for (const source of [
      fixture([1, -2]),
      concat(fixture([1, -2]), str(3, "new export")),
    ]) {
      const before = source.slice();
      const output = await prepareModelForFp16(source.buffer);
      expect(source).toEqual(before);
      expect(halfWeights(new Uint8Array(output.model))).toEqual([
        0x3c00, 0xc000,
      ]);
    }
  });

  it("preserves public FP32/shape records and unknown fields; converts internal values and both tensor attribute/storage forms", async () => {
    for (const packed of [false, true]) {
      const source = fixture([1, -2], packed);
      const original = source.slice();
      const result = await convertFixture(source);
      expect(source).toEqual(original);
      const oldGraph = get(source, 7),
        graph = get(result, 7);
      for (const id of [11, 12, 100, 101, 102])
        expect(get(graph, id)).toEqual(get(oldGraph, id));
      for (const id of [100, 101, 102])
        expect(get(result, id)).toEqual(get(source, id));
      expect(halfWeights(result)).toEqual([0x3c00, 0xc000]);
      const oldTensors = decode(oldGraph).filter((f) => f.id === 5);
      const tensors = decode(graph).filter((f) => f.id === 5);
      expect(tensors[1].raw).toEqual(oldTensors[1].raw); // Signed INT64 -1, bit exact.
      expect(scalar(tensors[0].data, 2)).toBe(10);
      expect(decode(tensors[0].data).some((f) => f.id === 4)).toBe(false);
      for (const id of [100, 101, 102])
        expect(get(tensors[0].data, id)).toEqual(get(oldTensors[0].data, id));
      const nodes = decode(graph)
        .filter((f) => f.id === 1)
        .map((f) => f.data);
      expect(nodes.map((n) => td.decode(get(n, 4)))).toEqual([
        "Cast",
        "Add",
        "Relu",
        "Constant",
        "Constant",
        "Cast",
      ]);
      expect(td.decode(get(nodes[1], 1))).toBe("graph_input_cast_0");
      expect(td.decode(get(nodes[2], 2))).toBe("graph_output_cast_0");
      expect(scalar(get(nodes[0], 5), 3)).toBe(10);
      expect(scalar(get(nodes[5], 5), 3)).toBe(1);
      const oldNodes = decode(oldGraph).filter((f) => f.id === 1);
      expect(get(nodes[2], 5)).toEqual(get(oldNodes[1].data, 5)); // Scalar schema FLOAT stays FLOAT.
      expect(scalar(get(get(nodes[3], 5), 5), 2)).toBe(10);
      expect(get(get(nodes[4], 5), 5)).toEqual(
        get(get(oldNodes[3].data, 5), 5),
      );
      const infos = decode(graph)
        .filter((f) => f.id === 13)
        .map((f) => f.data);
      expect(infos.map(name)).toEqual([
        "middle",
        "graph_input_cast_0",
        "graph_output_cast_0",
      ]);
      for (const i of infos) {
        const tt = get(get(i, 2), 1);
        expect(scalar(tt, 1)).toBe(10);
        expect(get(tt, 2)).toEqual(get(get(get(get(oldGraph, 11), 2), 1), 2));
      }
    }
  });

  it("rounds ties to even, gradual underflow, signed zero, and finite overflow edge without clamping", async () => {
    const values = [
      0,
      -0,
      1,
      -2,
      1 + 2 ** -11,
      1 + 3 * 2 ** -11,
      -(1 + 3 * 2 ** -11),
      2 ** -24,
      2 ** -25,
      -(2 ** -25),
      2 ** -25 + 2 ** -48,
      2 ** -14,
      2 ** -14 - 2 ** -25,
      2 ** -14 - 3 * 2 ** -25,
      2 ** -149,
      -(2 ** -149),
      65504,
      65519,
      -65519,
    ];
    const output = await convertFixture(fixture(values));
    expect(halfWeights(output)).toEqual([
      0, 0x8000, 0x3c00, 0xc000, 0x3c00, 0x3c02, 0xbc02, 1, 0, 0x8000, 1, 0x400,
      0x400, 0x3fe, 0, 0x8000, 0x7bff, 0x7bff, 0xfbff,
    ]);
  });

  it.each([65520, -65520, 1e10, Infinity, -Infinity, NaN])(
    "rejects nonfinite/overflow weight %s",
    async (value) => {
      await expect(
        prepareModelForFp16(fixture([value]).buffer),
      ).rejects.toThrow(/overflows finite FP16|nonfinite FLOAT/);
    },
  );

  it("rejects a second conversion because the graph already contains Casts", async () => {
    const result = await prepareModelForFp16(fixture().buffer);
    expect(halfWeights(new Uint8Array(result.model))).toEqual([0x3c00]);
    await expect(prepareModelForFp16(result.model)).rejects.toThrow(
      /existing Cast nodes are unsupported/,
    );
  });

  it("does not depend on subsequent changes to the input buffer", async () => {
    const bytes = fixture([1]);
    const pending = prepareModelForFp16(bytes.buffer);
    bytes.fill(0);
    const output = await pending;
    expect(halfWeights(new Uint8Array(output.model))).toEqual([0x3c00]);
  });

  it.each([
    ["truncated length", new Uint8Array([0x3a, 0x80])],
    ["truncated field", new Uint8Array([0x3a, 0x7f, 0])],
    ["field zero", new Uint8Array([0, 0])],
    ["groups", new Uint8Array([0x3b])],
    ["bad varint", new Uint8Array(11).fill(0x80)],
    ["empty model", new Uint8Array()],
    ["missing graph", int(1, 8)],
    ["duplicate graph", concat(fixture(), record(7, get(fixture(), 7)))],
    ["local function", concat(fixture(), record(25, new Uint8Array()))],
  ] as const)("fails closed on %s", async (_label, b) => {
    await expect(prepareModelForFp16(b.buffer)).rejects.toThrow(
      /FP16 preparation failed/,
    );
  });

  it.each([
    "dimensions",
    "alignment",
    "external",
    "duplicate",
    "mixed storage",
  ])("rejects malformed FLOAT tensor %s", async (kind) => {
    const source = fixture();
    let replaced = false;
    const graph = concat(
      ...decode(get(source, 7)).map((f) => {
        if (f.id !== 5 || replaced) return f.raw;
        replaced = true;
        let tensor = f.data;
        if (kind === "dimensions" || kind === "alignment") {
          tensor = concat(
            ...decode(tensor).map((t) => {
              if (kind === "dimensions" && t.id === 1) return int(1, 2);
              if (kind === "alignment" && t.id === 9)
                return record(9, new Uint8Array(3));
              return t.raw;
            }),
          );
        } else {
          const extra =
            kind === "external"
              ? record(13, new Uint8Array())
              : record(kind === "duplicate" ? 9 : 4, new Uint8Array(4));
          tensor = concat(tensor, extra);
        }
        return record(5, tensor);
      }),
    );
    const model = concat(
      ...decode(source).map((f) => (f.id === 7 ? record(7, graph) : f.raw)),
    );
    await expect(prepareModelForFp16(model.buffer)).rejects.toThrow(
      /FP16 preparation failed/,
    );
  });

  it("converts 200 MiB of FP32 weights without mutating the source", async () => {
    const count = (200 * 1024 * 1024) / 4;
    const weights = Buffer.alloc(count * 4, Buffer.from([0, 0, 128, 63]));
    weights.writeFloatLE(-2, weights.length / 2);
    weights.writeFloatLE(0.5, weights.length - 4);
    const tensor = concat(
      int(1, count),
      int(2, 1),
      str(8, "w"),
      record(9, weights),
    );
    const node = concat(
      str(1, "input"),
      str(1, "w"),
      str(2, "output"),
      str(4, "Add"),
    );
    const graph = concat(
      str(2, "large fixture"),
      record(1, node),
      record(5, tensor),
      record(11, info("input", count)),
      record(12, info("output", count)),
    );
    const source = concat(int(1, 8), record(7, graph), record(8, int(2, 17)));
    const hash = (b: Uint8Array) =>
      createHash("sha256").update(b).digest("hex");
    const originalHash = hash(source);
    const converted = await prepareModelForFp16(source.buffer);
    expect(hash(source)).toBe(originalHash);
    const output = new Uint8Array(converted.model);
    const convertedTensor = get(get(output, 7), 5);
    expect(scalar(convertedTensor, 2)).toBe(10);
    const raw = get(convertedTensor, 9);
    const expected = Buffer.alloc(count * 2, Buffer.from([0, 0x3c]));
    expected.writeUInt16LE(0xc000, expected.length / 2);
    expected.writeUInt16LE(0x3800, expected.length - 2);
    expect(raw.length).toBe(expected.length);
    expect(hash(raw)).toBe(hash(expected));
    expect(output.byteLength).toBeLessThan(source.byteLength);
  }, 30_000);

  it("bounds total bytes and record count", async () => {
    await expect(
      prepareModelForFp16(new ArrayBuffer(MAX_MODEL_BYTES + 1)),
    ).rejects.toThrow(/256 MiB/);
    const records = concat(...Array.from({ length: 100_001 }, () => int(1, 1)));
    await expect(prepareModelForFp16(records.buffer)).rejects.toThrow(
      /record limit/,
    );
  });
});

// Explicit opt-in only. No model downloads, Python imports, or artifact writes in
// the ordinary suite. Example:
// FP16_NOOVERSEG_MODEL=/path/original.onnx FP16_MODEL6280000=/path/new.onnx \
// FP16_VERIFY_PYTHON=/path/python npx vitest run src/inference/precision.spec.ts
const python = process.env.FP16_VERIFY_PYTHON;
it.skipIf(!python)(
  "matches NumPy around every finite half rounding boundary, both signs",
  async () => {
    const corpus = execFileSync(
      python!,
      [
        "-c",
        `
import sys
import numpy as np
positive = np.arange(0x7c00, dtype='<u2').view('<f2').astype('<f4')
midpoints = (positive[:-1] + positive[1:]) / np.float32(2)
values = np.concatenate([positive, midpoints, np.nextafter(midpoints, np.float32(-np.inf)), np.nextafter(midpoints, np.float32(np.inf))])
values = np.concatenate([values, -values]).astype('<f4')
sys.stdout.buffer.write(values.tobytes())
sys.stdout.buffer.write(values.astype('<f2').tobytes())
`,
      ],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    const count = corpus.length / 6;
    const values = Array.from({ length: count }, (_, i) =>
      corpus.readFloatLE(i * 4),
    );
    const output = halfWeights(await convertFixture(fixture(values)));
    const expected = Array.from({ length: count }, (_, i) =>
      corpus.readUInt16LE(count * 4 + i * 2),
    );
    expect(output).toEqual(expected);
  },
  30_000,
);

for (const [label, path, sha, outputSha, outputBytes] of [
  [
    "nooverseg",
    process.env.FP16_NOOVERSEG_MODEL,
    ORIGINAL_SHA,
    "2678991484de18f7c54b7075765caadcacfbe8743079d41d6d50620fe1dffb51",
    21278538,
  ],
  [
    "model6280000",
    process.env.FP16_MODEL6280000,
    NEW_SHA,
    "357b1a1ce5d4e0ee7a159818e716051c23288959e29cd444e0f187318ba8d7e9",
    23688906,
  ],
] as const) {
  describe.skipIf(!path)(`actual ${label} FP16 model`, () => {
    it("preserves the original, converts reserialized bytes, and rejects existing Casts", async () => {
      const source = new Uint8Array(readFileSync(path!));
      const hash = (b: Bytes) => createHash("sha256").update(b).digest("hex");
      expect(hash(source)).toBe(sha);
      const output = await prepareModelForFp16(source.buffer);
      expect(hash(source)).toBe(sha);
      expect(output.model.byteLength).toBe(outputBytes);
      expect(hash(new Uint8Array(output.model))).toBe(outputSha);
      await expect(prepareModelForFp16(output.model)).rejects.toThrow(
        /existing Cast nodes are unsupported/,
      );
      const reserialized = concat(source, str(3, "new export"));
      const converted = await prepareModelForFp16(reserialized.buffer);
      expect(converted.model.byteLength).toBeGreaterThan(outputBytes);
      expect(halfWeights(new Uint8Array(converted.model))).toEqual(
        halfWeights(new Uint8Array(output.model)),
      );
    }, 120_000);
    it.skipIf(!python)(
      "passes full ONNX, all NumPy weights/shapes and independent Python FP16 CPU equivalence",
      async () => {
        const result = await prepareModelForFp16(
          new Uint8Array(readFileSync(path!)).buffer,
        );
        const dir = mkdtempSync(join(tmpdir(), "neuroglancer-fp16-"));
        try {
          const output = join(dir, "browser.onnx");
          writeFileSync(output, new Uint8Array(result.model));
          const report = execFileSync(
            python!,
            ["build_tools/verify_inference_fp16.py", path!, output],
            { encoding: "utf8", timeout: 300_000, maxBuffer: 1024 * 1024 },
          );
          expect(JSON.parse(report).status).toBe("passed");
          console.info(`${label}: ${report.trim()}`);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
      330_000,
    );
  });
}
