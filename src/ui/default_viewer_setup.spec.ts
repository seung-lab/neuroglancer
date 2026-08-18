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

import { beforeAll, describe, expect, test, vi } from "vitest";

let convertLegacyAnnotationTags: (layer: any) => void;

beforeAll(async () => {
  vi.stubGlobal("WebGL2RenderingContext", {
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
  });
  ({ convertLegacyAnnotationTags } = await import(
    "#src/ui/default_viewer_setup.js"
  ));
});

describe("convertLegacyAnnotationTags", () => {
  test("converts tags to uniquely-named boolean properties and tools", () => {
    const layer = {
      type: "annotation",
      annotationProperties: [
        { id: "reviewed", type: "uint8" },
        { id: "reviewed2", type: "float32" },
        {
          id: "tag0",
          type: "uint8",
          tag: "reviewed",
          description: "First review",
          enum_values: [0, 1],
          enum_labels: ["no", "yes"],
        },
        { id: "tag1", type: "uint8", tag: "reviewed" },
      ],
      toolBindings: {
        A: "tagTool_tag0",
        B: "tagTool_tag1",
        C: "annotatePoint",
      },
    };

    convertLegacyAnnotationTags(layer);

    expect(layer.annotationProperties).toEqual([
      { id: "reviewed", type: "uint8" },
      { id: "reviewed2", type: "float32" },
      {
        id: "reviewed1",
        type: "bool",
        description: "First review",
      },
      { id: "reviewed3", type: "bool" },
    ]);
    expect(layer.toolBindings).toEqual({
      A: { type: "toggleBoolProperty", property: "reviewed1" },
      B: { type: "toggleBoolProperty", property: "reviewed3" },
      C: "annotatePoint",
    });
  });
});
