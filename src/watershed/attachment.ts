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

import type { ManagedUserLayer } from "#src/layer/index.js";
import type { MultiscaleVolumeChunkSource } from "#src/sliceview/volume/frontend.js";

// Runtime-only attachment at the segmentation subsource activation boundary.
// The datasource is loaded before it knows which managed layer will display it.
const attachments = new WeakMap<
  MultiscaleVolumeChunkSource,
  (layer: ManagedUserLayer) => () => void
>();

export function registerWatershedAttachment(
  volume: MultiscaleVolumeChunkSource,
  attach: (layer: ManagedUserLayer) => () => void,
): () => void {
  attachments.set(volume, attach);
  return () => {
    if (attachments.get(volume) === attach) attachments.delete(volume);
  };
}

export function attachWatershedVolume(
  volume: MultiscaleVolumeChunkSource,
  layer: ManagedUserLayer,
): (() => void) | undefined {
  return attachments.get(volume)?.(layer);
}
