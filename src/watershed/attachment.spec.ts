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

import { expect, it, vi } from "vitest";
import type { ManagedUserLayer } from "#src/layer/index.js";
import type { MultiscaleVolumeChunkSource } from "#src/sliceview/volume/frontend.js";
import {
  attachWatershedVolume,
  registerWatershedAttachment,
} from "#src/watershed/attachment.js";

it("only attaches registered volumes and forwards the actual owning layer", () => {
  const volume = {} as MultiscaleVolumeChunkSource;
  const layer = {} as ManagedUserLayer;
  const detach = vi.fn();
  const attach = vi.fn(() => detach);
  expect(attachWatershedVolume(volume, layer)).toBeUndefined();
  const remove = registerWatershedAttachment(volume, attach);
  expect(
    attachWatershedVolume({} as MultiscaleVolumeChunkSource, layer),
  ).toBeUndefined();
  expect(attachWatershedVolume(volume, layer)).toBe(detach);
  expect(attach).toHaveBeenCalledExactlyOnceWith(layer);
  detach();
  expect(detach).toHaveBeenCalledOnce();
  remove();
  expect(attachWatershedVolume(volume, layer)).toBeUndefined();
  expect(attach).toHaveBeenCalledOnce();
});

it("does not let an obsolete registration remove its replacement", () => {
  const volume = {} as MultiscaleVolumeChunkSource;
  const layer = {} as ManagedUserLayer;
  const oldAttach = vi.fn(() => () => {});
  const attach = vi.fn(() => () => {});
  const removeOld = registerWatershedAttachment(volume, oldAttach);
  const remove = registerWatershedAttachment(volume, attach);
  removeOld();
  removeOld();
  attachWatershedVolume(volume, layer);
  expect(oldAttach).not.toHaveBeenCalled();
  expect(attach).toHaveBeenCalledExactlyOnceWith(layer);
  remove();
  expect(attachWatershedVolume(volume, layer)).toBeUndefined();
});
