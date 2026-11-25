/**
 * @license
 * Copyright 2026 The Neuroglancer Authors
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

import { describe, it, expect } from "vitest";
import {
  joinBucketRow,
  splitBucketRow,
} from "#src/datasource/graphene/base.js";

describe("v2 fragment ids", () => {
  it("carry a bucket's index and the row it listed", () => {
    const row = "123:2/0-0.shard:10:20";
    expect(splitBucketRow(joinBucketRow(3, row))).toEqual({ index: 3, row });
  });

  it("are told apart from v1 ids, which name no bucket", () => {
    for (const row of ["~123:2/0-0.shard:10:20", "123:0:0-1_0-1_0-1"]) {
      expect(splitBucketRow(row)).toEqual({ index: undefined, row });
    }
  });
});
