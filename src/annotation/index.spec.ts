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

import { describe, expect, it } from "vitest";
import { AnnotationSource, AnnotationType } from "#src/annotation/index.js";

describe("capsule annotations", () => {
  it("round-trips capsule end radii through annotation state", () => {
    const source = new AnnotationSource(3);
    source.restoreState([
      {
        id: "capsule-1",
        type: "capsule",
        pointA: [1, 2, 3],
        pointB: [4, 5, 6],
        radiusA: 12.5,
        radiusB: 18.5,
      },
    ]);

    expect(source.toJSON()).toEqual([
      {
        id: "capsule-1",
        type: "capsule",
        pointA: [1, 2, 3],
        pointB: [4, 5, 6],
        radiusA: 12.5,
        radiusB: 18.5,
      },
    ]);
  });

  it("defaults capsule end radii to 2000 when omitted from state", () => {
    const source = new AnnotationSource(3);
    source.restoreState([
      {
        id: "capsule-2",
        type: "capsule",
        pointA: [0, 0, 0],
        pointB: [1, 0, 0],
      },
    ]);

    const annotation = source.get("capsule-2");
    expect(annotation).toMatchObject({
      type: AnnotationType.CAPSULE,
      radiusA: 2000,
      radiusB: 2000,
    });
  });

  it("uses shared radius as fallback for both capsule ends", () => {
    const source = new AnnotationSource(3);
    source.restoreState([
      {
        id: "capsule-3",
        type: "capsule",
        pointA: [0, 0, 0],
        pointB: [1, 0, 0],
        radius: 9,
      },
    ]);

    const annotation = source.get("capsule-3");
    expect(annotation).toMatchObject({
      type: AnnotationType.CAPSULE,
      radiusA: 9,
      radiusB: 9,
    });
  });
});
