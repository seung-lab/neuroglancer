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

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as model6280000Recipe from "#src/inference/model6280000_jsep_recipe.js";
import {
  inspectWebGpuCompatibility,
  prepareModelForWebGpu,
  prepareNooversegForWebGpu,
} from "#src/inference/prepare.js";

// Independent reference values, not imported from the implementation.
const ORIGINAL_SHA256 =
  "0493be1d38f98236a4782404e616569b5838020a5a892de429d30a5372285860";
const PREPARED_SHA256 =
  "529a6005da64066269ec29ac60151eaa4abcbf80a44e226e7068923d7c9a45df";
const ORIGINAL_BYTES = 42520250;
const PREPARED_BYTES = 42520386;
const originalPath = resolve("nooverseg.onnx");
// Legacy 2-D-folded artifacts are not valid oracles for Conv-only preparation.
const preparedPath = process.env.NOOVERSEG_PREPARE_PREPARED;
const hasOriginal = existsSync(originalPath);
const python = process.env.NOOVERSEG_PREPARE_PYTHON;
const NEW_ORIGINAL_SHA256 =
  "2c19eac209030e9f1d3b52d6dfaa72a509291f8644ca0e36fbe22231f2baac3c";
const NEW_PREPARED_SHA256 =
  "88604328d32e603a4d6de3d3625127e77311448fd9ad0bb45201cfdc85fd9828";
const NEW_ORIGINAL_BYTES = 47337104;
const NEW_PREPARED_BYTES = 47337252;
const newOriginalPath =
  process.env.MODEL6280000_PREPARE_ORIGINAL ??
  "/tmp/neuroglancer-model6280000.onnx";
const newPreparedPath = process.env.MODEL6280000_PREPARE_PREPARED;
const hasNewOriginal = existsSync(newOriginalPath);

function sha256(model: ArrayBuffer) {
  return createHash("sha256").update(new Uint8Array(model)).digest("hex");
}

function readModel(path: string): ArrayBuffer {
  // Do not expose a pooled Node Buffer's enclosing allocation to the API.
  return new Uint8Array(readFileSync(path)).buffer;
}

function hashBytes(hex: string): ArrayBuffer {
  return new Uint8Array(Buffer.from(hex, "hex")).buffer;
}

// Independent field-level oracle: changing anything but Conv padding fails,
// including initializer payloads, ConvTranspose nodes, or added Reshapes.
const onnxPreservationOracle = `
import copy
import sys
from collections import Counter
import onnx
actual = sys.stdin.buffer.read()
source = onnx.load(sys.argv[1])
model = onnx.load_model_from_string(actual)
expected = copy.deepcopy(source)
for node in expected.graph.node:
    if node.op_type == "Conv":
        kept = [copy.deepcopy(a) for a in node.attribute if a.name != "pads"]
        assert len(kept) == len(node.attribute) - 1
        assert not any(a.name == "auto_pad" for a in kept)
        del node.attribute[:]
        node.attribute.extend(kept)
        node.attribute.append(onnx.helper.make_attribute("auto_pad", "SAME_UPPER"))
assert [v.SerializeToString() for v in model.graph.initializer] == [
    v.SerializeToString() for v in source.graph.initializer
], "initializer protobufs changed"
assert [n.SerializeToString() for n in model.graph.node if n.op_type != "Conv"] == [
    n.SerializeToString() for n in source.graph.node if n.op_type != "Conv"
], "non-Conv node protobufs changed"
counts = Counter(n.op_type for n in model.graph.node)
assert counts == Counter(n.op_type for n in source.graph.node), "node counts changed"
assert counts["Conv"] == int(sys.argv[2])
assert counts["ConvTranspose"] == 3
assert model == expected, "ONNX fields changed outside Conv padding attributes"
if len(sys.argv) > 3:
    from build_tools.prepare_nooverseg_jsep import prepare_model
    assert actual == prepare_model(source).SerializeToString(), "browser recipe differs from Python transformer"
onnx.checker.check_model(model, full_check=True)
onnx.shape_inference.infer_shapes(model, strict_mode=True)
print("Conv-only preparation and full ONNX validation passed")
`;

afterEach(() => vi.restoreAllMocks());

describe("exact-model browser preparation", () => {
  it("passes the existing tiny fixed-profile concat model through unchanged", async () => {
    const model = readModel(resolve("testdata/inference/concat.onnx"));
    const expectedHash = sha256(model);
    const result = await prepareNooversegForWebGpu(model);
    expect(result).toEqual({
      model,
      status: "not-needed",
      reason: "unrecognized-model",
      sourceSha256: expectedHash,
      preparedSha256: expectedHash,
    });
    expect(result.model).toBe(model);
    expect(sha256(model)).toBe(expectedHash);
  });

  it.each([
    new ArrayBuffer(0),
    new TextEncoder().encode("nooverseg.onnx").buffer,
  ])(
    "passes arbitrary bytes through without parsing or filename matching (%#)",
    async (model) => {
      const result = await prepareNooversegForWebGpu(model);
      expect(result.model).toBe(model);
      expect(result.status).toBe("not-needed");
      expect(result.reason).toBe("unrecognized-model");
      expect(result.preparation).toBeUndefined();
      expect(result.sourceSha256).toBe(sha256(model));
      expect(result.preparedSha256).toBe(result.sourceSha256);
    },
  );

  it("recognizes the prepared fingerprint without allocating a rewritten model", async () => {
    // Branch-only unit test; real artifact/idempotence is tested below without
    // mocking crypto. No ONNX model or weights need to be committed for this.
    const model = new ArrayBuffer(1);
    const digest = vi
      .spyOn(crypto.subtle, "digest")
      .mockResolvedValueOnce(hashBytes(PREPARED_SHA256));
    const result = await prepareNooversegForWebGpu(model);
    expect(result).toEqual({
      model,
      status: "not-needed",
      reason: "already-prepared",
      sourceSha256: PREPARED_SHA256,
      preparedSha256: PREPARED_SHA256,
    });
    expect(result.model).toBe(model);
    expect(digest).toHaveBeenCalledTimes(1);
  });

  it("fails closed if the recipe does not produce the reference fingerprint", async () => {
    const model = new ArrayBuffer(ORIGINAL_BYTES);
    // Intentionally forge ONLY the input hash to exercise output verification.
    // The second digest runs the real implementation on the incorrect result.
    const digest = vi
      .spyOn(crypto.subtle, "digest")
      .mockResolvedValueOnce(hashBytes(ORIGINAL_SHA256));
    await expect(prepareNooversegForWebGpu(model)).rejects.toThrow(
      "nooverseg preparation failed: prepared SHA-256 mismatch",
    );
    expect(digest).toHaveBeenCalledTimes(2);
    expect(new Uint8Array(model).every((x) => x === 0)).toBe(true);
  });

  it("propagates hashing failure instead of reporting a successful preparation", async () => {
    vi.spyOn(crypto.subtle, "digest").mockRejectedValueOnce(
      new Error("digest unavailable"),
    );
    await expect(prepareNooversegForWebGpu(new ArrayBuffer(1))).rejects.toThrow(
      "digest unavailable",
    );
  });
});

describe("optional verified WebGPU recipes", () => {
  it("pins the generated second recipe to the independently verified artifacts", () => {
    expect(model6280000Recipe.ORIGINAL_SHA256).toBe(NEW_ORIGINAL_SHA256);
    expect(model6280000Recipe.PREPARED_SHA256).toBe(NEW_PREPARED_SHA256);
    expect(model6280000Recipe.ORIGINAL_BYTES).toBe(NEW_ORIGINAL_BYTES);
    expect(model6280000Recipe.PREPARED_BYTES).toBe(NEW_PREPARED_BYTES);
    let previous = 0;
    let outputSize = NEW_ORIGINAL_BYTES;
    let embeddedBytes = 0;
    for (const [start, end, base64] of model6280000Recipe.REPLACEMENTS) {
      expect(start).toBeGreaterThanOrEqual(previous);
      expect(end).toBeGreaterThanOrEqual(start);
      expect(end).toBeLessThanOrEqual(NEW_ORIGINAL_BYTES);
      const size = atob(base64).length;
      outputSize += size - (end - start);
      embeddedBytes += size;
      previous = end;
    }
    expect(outputSize).toBe(NEW_PREPARED_BYTES);
    // Conv protobuf records only, no initializers or learned weights.
    expect(embeddedBytes).toBeLessThan(20000);
  });

  it.each([
    [ORIGINAL_SHA256, "nooverseg", 34],
    [NEW_ORIGINAL_SHA256, "model6280000", 37],
  ] as const)(
    "inspects original SHA %s without rewriting",
    async (hash, name, count) => {
      const model = new ArrayBuffer(8);
      const digest = vi
        .spyOn(crypto.subtle, "digest")
        .mockResolvedValueOnce(hashBytes(hash));
      const analysis = await inspectWebGpuCompatibility(model);
      expect(analysis.status).toBe("available");
      expect(analysis.model).toBe(name);
      expect(analysis.message).toContain(hash);
      expect(analysis.message).toContain("not a guarantee");
      expect(analysis.fixes[0]).toContain(`${count} Conv`);
      expect(analysis.fixes.join(" ")).toContain("SAME_UPPER");
      expect(analysis.fixes).toHaveLength(1);
      expect(analysis.fixes.join(" ")).not.toContain("ConvTranspose");
      expect(digest).toHaveBeenCalledTimes(1);
      expect(new Uint8Array(model)).toEqual(new Uint8Array(8));
    },
  );

  it.each([
    [ORIGINAL_SHA256, true, true],
    [ORIGINAL_SHA256, undefined, true],
    [ORIGINAL_SHA256, false, false],
    [NEW_ORIGINAL_SHA256, true, true],
    [NEW_ORIGINAL_SHA256, undefined, false],
    [NEW_ORIGINAL_SHA256, false, false],
  ] as const)(
    "toggle: original %s enabled=%s applies=%s",
    async (hash, enabled, applies) => {
      const old = hash === ORIGINAL_SHA256;
      const preparedHash = old ? PREPARED_SHA256 : NEW_PREPARED_SHA256;
      const model = new ArrayBuffer(old ? ORIGINAL_BYTES : NEW_ORIGINAL_BYTES);
      const digest = vi
        .spyOn(crypto.subtle, "digest")
        .mockResolvedValueOnce(hashBytes(hash));
      if (applies) digest.mockResolvedValueOnce(hashBytes(preparedHash));
      const result = await prepareModelForWebGpu(model, enabled);
      expect(result.status).toBe(applies ? "applied" : "not-needed");
      expect(result.model === model).toBe(!applies);
      expect(result.sourceSha256).toBe(hash);
      expect(result.preparedSha256).toBe(applies ? preparedHash : hash);
      expect(result.preparation).toBe(
        applies ? `${old ? "nooverseg" : "model6280000"}-jsep` : undefined,
      );
      expect(result.compatibilityAnalysis.status).toBe("available");
      expect(result.compatibilityAnalysis.model).toBe(
        old ? "nooverseg" : "model6280000",
      );
      expect(digest).toHaveBeenCalledTimes(applies ? 2 : 1);
      expect(new Uint8Array(model).every((x) => x === 0)).toBe(true);
    },
  );

  it.each([NEW_ORIGINAL_SHA256, NEW_PREPARED_SHA256])(
    "keeps the legacy API strictly old-only for %s",
    async (hash) => {
      const model = new ArrayBuffer(1);
      const digest = vi
        .spyOn(crypto.subtle, "digest")
        .mockResolvedValueOnce(hashBytes(hash));
      const result = await prepareNooversegForWebGpu(model);
      expect(result.model).toBe(model);
      expect(result.status).toBe("not-needed");
      expect(result.reason).toBe("unrecognized-model");
      expect(result.preparation).toBeUndefined();
      expect(result).not.toHaveProperty("compatibilityAnalysis");
      expect(digest).toHaveBeenCalledTimes(1);
    },
  );

  it.each([true, false, undefined])(
    "never rewrites either prepared artifact (enabled=%s)",
    async (enabled) => {
      for (const hash of [PREPARED_SHA256, NEW_PREPARED_SHA256]) {
        const model = new ArrayBuffer(1);
        const digest = vi
          .spyOn(crypto.subtle, "digest")
          .mockResolvedValueOnce(hashBytes(hash));
        const analysis = await inspectWebGpuCompatibility(model);
        expect(analysis.status).toBe("already-prepared");
        digest.mockResolvedValueOnce(hashBytes(hash));
        const result = await prepareModelForWebGpu(model, enabled);
        expect(result.model).toBe(model);
        expect(result.reason).toBe("already-prepared");
        expect(result.preparation).toBeUndefined();
        expect(result.compatibilityAnalysis).toEqual(analysis);
        expect(result.preparedSha256).toBe(hash);
        digest.mockRestore();
      }
    },
  );

  it.each([true, false, undefined])(
    "leaves unknown/malformed bytes visibly unverified (enabled=%s)",
    async (enabled) => {
      for (const model of [
        new ArrayBuffer(0),
        new TextEncoder().encode("model6280000.onnx").buffer,
      ]) {
        const before = new Uint8Array(model).slice();
        const result = await prepareModelForWebGpu(model, enabled);
        expect(result.model).toBe(model);
        expect(result.preparation).toBeUndefined();
        expect(result.reason).toBe("unrecognized-model");
        expect(result.compatibilityAnalysis.status).toBe("unverified");
        expect(result.compatibilityAnalysis.model).toBeUndefined();
        expect(result.compatibilityAnalysis.fixes).toEqual([]);
        expect(result.compatibilityAnalysis.message).toContain(sha256(model));
        expect(result.compatibilityAnalysis.message).toContain("unverified");
        expect(new Uint8Array(model)).toEqual(before);
        expect(await inspectWebGpuCompatibility(model)).toEqual(
          result.compatibilityAnalysis,
        );
      }
    },
  );

  it.each([ORIGINAL_SHA256, NEW_ORIGINAL_SHA256])(
    "rejects a forged original hash with invalid size (%s)",
    async (hash) => {
      vi.spyOn(crypto.subtle, "digest").mockResolvedValueOnce(hashBytes(hash));
      await expect(
        prepareModelForWebGpu(new ArrayBuffer(1), true),
      ).rejects.toThrow("preparation failed: source size mismatch");
    },
  );

  it("fails closed on an incorrect model6280000 output fingerprint", async () => {
    const model = new ArrayBuffer(NEW_ORIGINAL_BYTES);
    const digest = vi
      .spyOn(crypto.subtle, "digest")
      .mockResolvedValueOnce(hashBytes(NEW_ORIGINAL_SHA256));
    await expect(prepareModelForWebGpu(model, true)).rejects.toThrow(
      "model6280000 preparation failed: prepared SHA-256 mismatch",
    );
    expect(digest).toHaveBeenCalledTimes(2);
    expect(new Uint8Array(model).every((x) => x === 0)).toBe(true);
  });

  it("copies all untouched spans and exact replacements from a sparse payload", async () => {
    const model = new ArrayBuffer(NEW_ORIGINAL_BYTES);
    const input = new Uint8Array(model);
    // Probe each side of every splice and distant unchanged learned weights.
    input[1000000] = 19;
    input[20000000] = 37;
    for (const [start, end] of model6280000Recipe.REPLACEMENTS) {
      if (start > 0) input[start - 1] = 23;
      if (end < input.length) input[end] = 41;
    }
    const before = sha256(model);
    const parts: Uint8Array[] = [];
    let offset = 0;
    for (const [start, end, base64] of model6280000Recipe.REPLACEMENTS) {
      parts.push(input.subarray(offset, start), Buffer.from(base64, "base64"));
      offset = end;
    }
    parts.push(input.subarray(offset));
    const expected = Buffer.concat(parts);
    expect(expected.byteLength).toBe(NEW_PREPARED_BYTES);
    vi.spyOn(crypto.subtle, "digest")
      .mockResolvedValueOnce(hashBytes(NEW_ORIGINAL_SHA256))
      .mockResolvedValueOnce(hashBytes(NEW_PREPARED_SHA256));
    const result = await prepareModelForWebGpu(model, true);
    expect(Buffer.from(result.model).equals(expected)).toBe(true);
    expect(sha256(model)).toBe(before);
  });

  it("propagates digest failure in inspection and the opt-in engine", async () => {
    const digest = vi.spyOn(crypto.subtle, "digest");
    digest.mockRejectedValueOnce(new Error("digest unavailable"));
    await expect(
      inspectWebGpuCompatibility(new ArrayBuffer(0)),
    ).rejects.toThrow("digest unavailable");
    digest.mockRejectedValueOnce(new Error("digest unavailable"));
    await expect(
      prepareModelForWebGpu(new ArrayBuffer(0), false),
    ).rejects.toThrow("digest unavailable");
  });
});

// Local opt-in coverage: the user-owned large models must never be checked in.
// The core unit tests above run without either file or Python. With the exact
// original at repository root, verify the actual model and known artifact hash.
// Set NOOVERSEG_PREPARE_PYTHON to a Python with numpy/onnx 1.23.2 to additionally
// compare against the offline transformer and full ONNX checker, without saving
// or changing any model files. No application build is involved.
describe.skipIf(!hasOriginal)("local exact nooverseg artifact", () => {
  it("reproduces the prepared artifact byte-for-byte, preserves the source, and is idempotent", async () => {
    const model = readModel(originalPath);
    expect(sha256(model)).toBe(ORIGINAL_SHA256);
    const result = await prepareNooversegForWebGpu(model);
    expect(result.model).not.toBe(model);
    expect(result.model.byteLength).toBe(PREPARED_BYTES);
    expect(result.preparation).toBe("nooverseg-jsep");
    expect(result.status).toBe("applied");
    expect(result.reason).toBe("exact-original");
    expect(result.sourceSha256).toBe(ORIGINAL_SHA256);
    expect(result.preparedSha256).toBe(PREPARED_SHA256);
    expect(sha256(result.model)).toBe(PREPARED_SHA256);
    expect(sha256(model)).toBe(ORIGINAL_SHA256);
    if (preparedPath !== undefined) {
      expect(Buffer.from(result.model).equals(readFileSync(preparedPath))).toBe(
        true,
      );
    }
    const second = await prepareNooversegForWebGpu(result.model);
    expect(second.model).toBe(result.model);
    expect(second.status).toBe("not-needed");
    expect(second.reason).toBe("already-prepared");
    expect(second.preparation).toBeUndefined();
    expect(second.sourceSha256).toBe(PREPARED_SHA256);
    expect(second.preparedSha256).toBe(PREPARED_SHA256);
  });

  it("does not rewrite a same-size model with one changed byte or an appended unknown field", async () => {
    const altered = readModel(originalPath);
    new Uint8Array(altered)[100] ^= 1;
    const extended = new Uint8Array(ORIGINAL_BYTES + 3);
    extended.set(new Uint8Array(readModel(originalPath)));
    // Valid protobuf unknown field 100, varint 1. Even this innocuous metadata
    // change must not match: fixed offsets are authorized by the exact hash only.
    extended.set([0xa0, 0x06, 0x01], ORIGINAL_BYTES);
    for (const model of [altered, extended.buffer]) {
      const expectedHash = sha256(model);
      const result = await prepareNooversegForWebGpu(model);
      expect(result.model).toBe(model);
      expect(result.status).toBe("not-needed");
      expect(result.reason).toBe("unrecognized-model");
      expect(result.preparation).toBeUndefined();
      expect(result.sourceSha256).toBe(expectedHash);
      expect(sha256(model)).toBe(expectedHash);
    }
  });

  it("uses a stable snapshot if the caller mutates the original while hashing", async () => {
    const model = readModel(originalPath);
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(
      async (algorithm, bytes) => {
        new Uint8Array(model)[100] ^= 1;
        return digest(algorithm, bytes);
      },
    );
    const result = await prepareNooversegForWebGpu(model);
    expect(result.status).toBe("applied");
    expect(sha256(result.model)).toBe(PREPARED_SHA256);
    expect(sha256(model)).not.toBe(ORIGINAL_SHA256);
  });

  it.skipIf(!python)(
    "matches the Python transformer and passes full ONNX validation",
    async () => {
      const result = await prepareNooversegForWebGpu(readModel(originalPath));
      const output = execFileSync(
        python!,
        [
          "-c",
          onnxPreservationOracle,
          originalPath,
          "34",
          "compare-transformer",
        ],
        { input: Buffer.from(result.model), encoding: "utf8", timeout: 30000 },
      );
      expect(output.trim()).toBe(
        "Conv-only preparation and full ONNX validation passed",
      );
    },
    30000,
  );
});

// Optional prepared oracle paths must refer to fresh Conv-only artifacts, not
// legacy folded scratch outputs. No model paths are ever written by these tests.
describe.skipIf(!hasNewOriginal)("local exact model6280000 artifact", () => {
  it("is opt-in, reproduces the Conv-only output exactly and is idempotent", async () => {
    const model = readModel(newOriginalPath);
    expect(model.byteLength).toBe(NEW_ORIGINAL_BYTES);
    expect(sha256(model)).toBe(NEW_ORIGINAL_SHA256);
    expect((await inspectWebGpuCompatibility(model)).status).toBe("available");
    for (const enabled of [false, undefined]) {
      const result = await prepareModelForWebGpu(model, enabled);
      expect(result.model).toBe(model);
      expect(result.preparation).toBeUndefined();
      expect(result.compatibilityAnalysis.status).toBe("available");
    }
    const legacy = await prepareNooversegForWebGpu(model);
    expect(legacy.model).toBe(model);
    expect(legacy.reason).toBe("unrecognized-model");
    const result = await prepareModelForWebGpu(model, true);
    expect(result.model).not.toBe(model);
    expect(result.model.byteLength).toBe(NEW_PREPARED_BYTES);
    expect(result.preparation).toBe("model6280000-jsep");
    expect(result.status).toBe("applied");
    expect(result.sourceSha256).toBe(NEW_ORIGINAL_SHA256);
    expect(result.preparedSha256).toBe(NEW_PREPARED_SHA256);
    expect(result.compatibilityAnalysis).toEqual(
      await inspectWebGpuCompatibility(model),
    );
    expect(sha256(result.model)).toBe(NEW_PREPARED_SHA256);
    expect(sha256(model)).toBe(NEW_ORIGINAL_SHA256);
    if (newPreparedPath !== undefined) {
      const oracle = readFileSync(newPreparedPath);
      expect(oracle.byteLength).toBe(NEW_PREPARED_BYTES);
      expect(Buffer.from(result.model).equals(oracle)).toBe(true);
    }
    for (const enabled of [true, false, undefined]) {
      const second = await prepareModelForWebGpu(result.model, enabled);
      expect(second.model).toBe(result.model);
      expect(second.reason).toBe("already-prepared");
      expect(second.preparation).toBeUndefined();
      expect(second.compatibilityAnalysis.status).toBe("already-prepared");
      expect(second.sourceSha256).toBe(NEW_PREPARED_SHA256);
      expect(second.preparedSha256).toBe(NEW_PREPARED_SHA256);
    }
  });

  it("never rewrites mutated, truncated or metadata-extended models", async () => {
    const model = readModel(newOriginalPath);
    new Uint8Array(model)[100] ^= 1;
    const extended = new Uint8Array(NEW_ORIGINAL_BYTES + 3);
    extended.set(new Uint8Array(readModel(newOriginalPath)));
    extended.set([0xa0, 0x06, 0x01], NEW_ORIGINAL_BYTES);
    for (const altered of [
      model,
      model.slice(0, NEW_ORIGINAL_BYTES - 1),
      extended.buffer,
    ]) {
      const before = sha256(altered);
      const result = await prepareModelForWebGpu(altered, true);
      expect(result.model).toBe(altered);
      expect(result.preparation).toBeUndefined();
      expect(result.compatibilityAnalysis.status).toBe("unverified");
      expect(result.sourceSha256).toBe(before);
      expect(result.preparedSha256).toBe(before);
      expect(sha256(altered)).toBe(before);
    }
  });

  it("snapshots the new original before awaiting hashing", async () => {
    const model = readModel(newOriginalPath);
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(
      async (algorithm, bytes) => {
        new Uint8Array(model)[100] ^= 1;
        return digest(algorithm, bytes);
      },
    );
    const result = await prepareModelForWebGpu(model, true);
    expect(result.status).toBe("applied");
    expect(sha256(result.model)).toBe(NEW_PREPARED_SHA256);
    expect(sha256(model)).not.toBe(NEW_ORIGINAL_SHA256);
  });

  it.skipIf(!python)(
    "preserves every ONNX field except Conv padding and passes full validation",
    async () => {
      const result = await prepareModelForWebGpu(
        readModel(newOriginalPath),
        true,
      );
      const output = execFileSync(
        python!,
        ["-c", onnxPreservationOracle, newOriginalPath, "37"],
        { input: Buffer.from(result.model), encoding: "utf8", timeout: 30000 },
      );
      expect(output.trim()).toBe(
        "Conv-only preparation and full ONNX validation passed",
      );
    },
    30000,
  );
});
