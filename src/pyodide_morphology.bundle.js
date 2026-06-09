// Note: This file uses ".js" rather than ".ts" extension because we cannot rely
// on Node.js subpath imports to translate paths for Workers since those paths
// must be valid for use in `new URL` with multiple bundlers.
//
// Worker entry for the pyodide morphology compute (TM-304). Mirrors
// chunk_worker.bundle.js: register handlers first, then import
// worker_rpc_context.js LAST so the RPC channel handshake (`sendReady()`) fires
// only after the handler is registered. Pyodide itself boots asynchronously
// inside morphology_handler.js and is gated per-request, not by the handshake.
import "#src/util/polyfills.js";
import "#src/editing/tool_runtimes/morphology_handler.js";
import "#src/worker_rpc_context.js";
