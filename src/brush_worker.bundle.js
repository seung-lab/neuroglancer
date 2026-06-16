// Note: This file uses ".js" rather than ".ts" extension because we cannot rely
// on Node.js subpath imports to translate paths for Workers since those paths
// must be valid for use in `new URL` with multiple bundlers.
//
// Dedicated brush rasterization worker (TM-322 phase 3): runs the per-tile
// stroke kernel, writing covered voxels directly into SharedArrayBuffer-backed
// chunk buffers. The handler installs `self.onmessage` and posts a ready signal.
import "#src/util/polyfills.js";
import "#src/editing/tool_runtimes/brush_worker_handler.js";
