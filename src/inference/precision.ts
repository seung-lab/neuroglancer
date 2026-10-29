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

/**
 * Experimental native ORT FP16 preparation, independent of JSEP preparation.
 * Attempts conversion for any explicitly selected model, without a fingerprint gate.
 * NOT a general ONNX converter: unsupported graph structures fail visibly.
 * No dependencies, embedded weights, shape/layout rewrites or global cache.
 *
 * The bounded protobuf walk changes FLOAT tensor payloads/types and internal
 * value types, renames the public boundary uses, and inserts two Casts. Unknown
 * field records and nonfloating tensors are copied verbatim. Scalar FLOAT/FLOATS
 * attributes remain schema FLOAT. Functions, subgraphs, sparse/external FLOAT
 * tensors and existing Casts are unsupported; other operator/type incompatibilities
 * may be rejected by ORT during session creation or execution.
 * Verification: build_tools/verify_inference_fp16.py (checker, NumPy and CPU).
 *
 * Weights use IEEE nearest-even, including signed zero and gradual underflow;
 * there is NO flooring/saturation. Nonfinite weights/half overflow fail closed.
 * Finite weights do not guarantee finite activations, device FP16 support, or
 * segmentation accuracy. The caller must retain the original for FP32 fallback.
 */

import { MAX_MODEL_BYTES } from "#src/inference/model.js";
const MAX_RECORDS = 100_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function fail(reason: string): never {
  throw new Error(`FP16 preparation failed: ${reason}`);
}

/** Attempt FP16 conversion. Never mutates/detaches the supplied buffer. */
export async function prepareModelForFp16(
  model: ArrayBuffer,
): Promise<{ model: ArrayBuffer }> {
  if (model.byteLength > MAX_MODEL_BYTES)
    fail(`model exceeds ${MAX_MODEL_BYTES / (1024 * 1024)} MiB limit`);
  const source = model.slice(0);
  return { model: new Converter().model(new Uint8Array(source)).buffer };
}

type Bytes = Uint8Array<ArrayBuffer>;
interface Field {
  id: number;
  wire: number;
  raw: Bytes;
  data: Bytes;
}

// Skip even signed/unknown int64 varints without rounding them through JS Number.
function varintEnd(b: Bytes, start: number): number {
  for (let i = 0; i < 10; ++i) {
    const p = start + i;
    if (p >= b.length) fail("truncated varint");
    if (i === 9 && b[p] > 1) fail("invalid varint");
    if (b[p] < 128) return p + 1;
  }
  return fail("invalid varint");
}

function uint(b: Bytes): number {
  let n = 0;
  let scale = 1;
  for (const x of b) {
    n += (x & 127) * scale;
    scale *= 128;
  }
  if (!Number.isSafeInteger(n)) fail("integer exceeds safe range");
  return n;
}

function varint(n: number): Bytes {
  const out: number[] = [];
  do {
    out.push(n % 128 | (n >= 128 ? 128 : 0));
    n = Math.floor(n / 128);
  } while (n);
  return new Uint8Array(out);
}

function join(parts: readonly Bytes[]): Bytes {
  const size = parts.reduce((n, p) => n + p.length, 0);
  if (size > MAX_MODEL_BYTES)
    fail(`output exceeds ${MAX_MODEL_BYTES / (1024 * 1024)} MiB limit`);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const p of parts) {
    result.set(p, offset);
    offset += p.length;
  }
  return result;
}

function field(id: number, data: Bytes, wire = 2): Bytes {
  return join([
    varint(id * 8 + wire),
    ...(wire === 2 ? [varint(data.length)] : []),
    data,
  ]);
}
function integer(id: number, value: number): Bytes {
  return field(id, varint(value), 0);
}
function text(id: number, value: string): Bytes {
  return field(id, encoder.encode(value));
}
function one(fields: Field[], id: number, wire: number): Field {
  const values = fields.filter((f) => f.id === id);
  if (values.length !== 1 || values[0].wire !== wire) {
    fail(`expected one field ${id} with wire type ${wire}`);
  }
  return values[0];
}
function string(f: Field): string {
  if (f.wire !== 2) fail("invalid string wire type");
  return decoder.decode(f.data);
}

/** Float32 bits -> binary16 bits, round-to-nearest ties-to-even. */
function half(bits: number): number {
  const sign = (bits >>> 16) & 0x8000;
  const exponent = (bits >>> 23) & 255;
  const fraction = bits & 0x7fffff;
  if (exponent === 255) fail("nonfinite FLOAT tensor value");
  const e = exponent - 127;
  if (e < -25) return sign;
  const shift = e < -14 ? -e - 1 : 13;
  const significand = fraction | 0x800000;
  const divisor = 2 ** shift;
  let rounded = Math.floor(significand / divisor);
  const remainder = significand % divisor;
  if (remainder > divisor / 2 || (remainder === divisor / 2 && rounded % 2)) {
    ++rounded;
  }
  const magnitude = e < -14 ? rounded : (e + 14) * 1024 + rounded;
  if (magnitude >= 0x7c00)
    fail("FLOAT tensor overflows finite FP16 (no clamping)");
  return sign | magnitude;
}

class Converter {
  private remaining = MAX_RECORDS;

  private fields(b: Bytes): Field[] {
    const result: Field[] = [];
    let p = 0;
    while (p < b.length) {
      if (--this.remaining < 0) fail("protobuf record limit exceeded");
      const start = p;
      p = varintEnd(b, p);
      const tag = uint(b.subarray(start, p));
      const id = Math.floor(tag / 8);
      const wire = tag % 8;
      if (id === 0 || id > 0x1fffffff) fail("invalid protobuf field number");
      let dataStart = p;
      switch (wire) {
        case 0:
          p = varintEnd(b, p);
          break;
        case 1:
          p += 8;
          break;
        case 2: {
          const end = varintEnd(b, p);
          const length = uint(b.subarray(p, end));
          dataStart = end;
          p = end + length;
          break;
        }
        case 5:
          p += 4;
          break;
        default:
          fail("unsupported protobuf wire type");
      }
      if (p > b.length) fail("truncated protobuf field");
      result.push({
        id,
        wire,
        raw: b.subarray(start, p),
        data: b.subarray(dataStart, p),
      });
    }
    return result;
  }

  model(b: Bytes): Bytes {
    const fields = this.fields(b);
    one(fields, 7, 2);
    if (fields.some((f) => f.id === 25))
      fail("local functions are unsupported");
    return join(
      fields.map((f) => (f.id === 7 ? field(7, this.graph(f.data)) : f.raw)),
    );
  }

  private tensor(b: Bytes): Bytes {
    const fields = this.fields(b);
    if (uint(one(fields, 2, 0).data) !== 1) return b;
    if (fields.some((f) => [3, 13, 14].includes(f.id))) {
      fail("segmented/external FLOAT tensors are unsupported");
    }
    const raw = fields.filter((f) => f.id === 9);
    const floats = fields.filter((f) => f.id === 4);
    if (raw.length > 1 || (raw.length && floats.length))
      fail("ambiguous FLOAT payload");
    const payloads = raw.length
      ? [one(fields, 9, 2).data]
      : floats.map((f) => {
          if (f.wire !== 2 && f.wire !== 5)
            fail("invalid float_data wire type");
          return f.data;
        });
    const data = join(payloads);
    if (data.length % 4) fail("misaligned FLOAT payload");
    // Check dims/payload agreement without ever interpreting shape tensors.
    let elements = 1;
    for (const f of fields.filter((f) => f.id === 1)) {
      const dims =
        f.wire === 2
          ? this.packedIntegers(f.data)
          : [uint(one([f], 1, 0).data)];
      for (const d of dims) {
        elements *= d;
        if (!Number.isSafeInteger(elements) || elements > MAX_MODEL_BYTES / 2)
          fail("invalid FLOAT tensor dimensions");
      }
    }
    if (elements !== data.length / 4) fail("FLOAT dimensions/payload mismatch");
    const output = new Uint8Array(data.length / 2);
    const inputView = new DataView(
      data.buffer,
      data.byteOffset,
      data.byteLength,
    );
    const outputView = new DataView(output.buffer);
    for (let i = 0; i < data.length / 4; ++i) {
      outputView.setUint16(i * 2, half(inputView.getUint32(i * 4, true)), true);
    }
    return join([
      ...fields
        .filter((f) => ![4, 9].includes(f.id))
        .map((f) => (f.id === 2 ? integer(2, 10) : f.raw)),
      field(9, output),
    ]);
  }

  private packedIntegers(b: Bytes): number[] {
    const out: number[] = [];
    for (let p = 0; p < b.length; ) {
      if (out.length >= 32) fail("tensor rank exceeds limit");
      const end = varintEnd(b, p);
      out.push(uint(b.subarray(p, end)));
      p = end;
    }
    return out;
  }

  // Recursion has fixed schema depth (Model/Graph/Node/Attribute/Tensor or
  // ValueInfo/Type/TensorType). Never recursively walk unknown fields.
  private attribute(b: Bytes): Bytes {
    const fields = this.fields(b);
    if (fields.some((f) => [6, 11, 22, 23].includes(f.id)))
      fail("subgraphs/sparse attributes are unsupported");
    return join(
      fields.map((f) =>
        [5, 10].includes(f.id) ? field(f.id, this.tensor(f.data)) : f.raw,
      ),
    );
  }

  private value(b: Bytes, name?: string): Bytes {
    return join(
      this.fields(b).map((f) => {
        if (f.id === 1 && name !== undefined) return text(1, name);
        if (f.id !== 2) return f.raw;
        return field(
          2,
          join(
            this.fields(f.data).map((t) => {
              if (t.id !== 1) return t.raw;
              return field(
                1,
                join(
                  this.fields(t.data).map((v) =>
                    v.id === 1 && uint(one([v], 1, 0).data) === 1
                      ? integer(1, 10)
                      : v.raw,
                  ),
                ),
              );
            }),
          ),
        );
      }),
    );
  }

  private cast(input: string, output: string, name: string, to: number): Bytes {
    return field(
      1,
      join([
        text(1, input),
        text(2, output),
        text(3, name),
        text(4, "Cast"),
        field(5, join([text(1, "to"), integer(3, to), integer(20, 2)])),
      ]),
    );
  }

  private graph(b: Bytes): Bytes {
    const fields = this.fields(b);
    if (fields.some((f) => f.id === 15))
      fail("sparse initializers are unsupported");
    const input = one(fields, 11, 2);
    const output = one(fields, 12, 2);
    const nameOf = (f: Field) => string(one(this.fields(f.data), 1, 2));
    const inName = nameOf(input);
    const outName = nameOf(output);
    if (inName === outName) fail("aliased public boundaries");
    const names = new Map([
      [inName, "graph_input_cast_0"],
      [outName, "graph_output_cast_0"],
    ]);
    // Public tensors must stay FP32. Verify rather than assume.
    for (const f of [input, output]) {
      const type = one(this.fields(f.data), 2, 2);
      const tensorType = one(this.fields(type.data), 1, 2);
      if (uint(one(this.fields(tensorType.data), 1, 0).data) !== 1)
        fail("public boundary is not FLOAT");
    }
    const rename = (f: Field) => {
      const name = string(f);
      if (
        [...names.values(), "graph_input_cast0", "graph_output_cast0"].includes(
          name,
        )
      )
        fail("boundary name collision");
      return names.has(name) ? text(f.id, names.get(name)!) : f.raw;
    };
    const result: Bytes[] = [
      this.cast(inName, names.get(inName)!, "graph_input_cast0", 10),
    ];
    for (const f of fields) {
      switch (f.id) {
        case 1: {
          const node = this.fields(f.data);
          if (string(one(node, 4, 2)) === "Cast")
            fail("existing Cast nodes are unsupported");
          result.push(
            field(
              1,
              join(
                node.map((n) => {
                  if (n.id === 1 || n.id === 2) return rename(n);
                  if (n.id === 5) return field(5, this.attribute(n.data));
                  return n.raw;
                }),
              ),
            ),
          );
          break;
        }
        case 5:
          result.push(field(5, this.tensor(f.data)));
          break;
        case 13: {
          const name = nameOf(f);
          result.push(field(13, this.value(f.data, names.get(name))));
          break;
        }
        default:
          result.push(f.raw); // Includes exact public ValueInfo/shape records.
      }
    }
    result.push(
      this.cast(names.get(outName)!, outName, "graph_output_cast0", 1),
    );
    result.push(field(13, this.value(input.data, names.get(inName))));
    result.push(field(13, this.value(output.data, names.get(outName))));
    return join(result);
  }
}
