/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest";

import {
  imageScalarToUint8,
  UnsupportedImageDataTypeError,
} from "#src/editing/tool_runtimes/image_scalar_to_uint8.js";

describe("imageScalarToUint8", () => {
  it("passes uint8 through as an independent copy", () => {
    const source = Uint8Array.from([0, 127, 255]);
    const result = imageScalarToUint8(source, "uint8");
    expect([...result]).toEqual([0, 127, 255]);
    result[0] = 42;
    expect(source[0]).toBe(0); // not aliased
  });

  it("scales uint16 across its full range to [0, 255]", () => {
    const source = Uint16Array.from([0, 32768, 65535]);
    expect([...imageScalarToUint8(source, "uint16")]).toEqual([0, 128, 255]);
  });

  it("shifts signed int8 so the minimum lands on 0", () => {
    const source = Int8Array.from([-128, 0, 127]);
    expect([...imageScalarToUint8(source, "int8")]).toEqual([0, 128, 255]);
  });

  it("scales float32 assuming a normalized [0, 1] range", () => {
    const source = Float32Array.from([0, 0.5, 1]);
    expect([...imageScalarToUint8(source, "float32")]).toEqual([0, 128, 255]);
  });

  it("clamps out-of-band float32 values into the byte range", () => {
    const source = Float32Array.from([-0.5, 2]);
    expect([...imageScalarToUint8(source, "float32")]).toEqual([0, 255]);
  });

  it("rejects uint64 images", () => {
    expect(() => imageScalarToUint8([1, 2], "uint64")).toThrow(
      UnsupportedImageDataTypeError,
    );
  });
});
