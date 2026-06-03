/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * @file Public entry point for the voxel editing module.
 *
 * The active edit session is owned by `EditSessionHost`, constructed by the
 * Viewer (see `src/viewer.ts`). The session sidebar, entry modal, and
 * per-tool panels are wired into the side-panel manager from the Viewer.
 */

export {
  EditSessionHost,
  TrackableEditSessionIntent,
} from "#src/editing/edit_session_host.js";
export type {
  HostSessionConfig,
  EditSessionIntent,
} from "#src/editing/edit_session_host.js";
export { LocalPatchChunk } from "#src/editing/local_patch_chunk.js";
export { LocalPatchSource } from "#src/editing/local_patch_source.js";
export { LocalPatchStore } from "#src/editing/local_patch_store.js";
export { PatchTextureCache } from "#src/editing/patch_texture_cache.js";
