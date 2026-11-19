#!/usr/bin/env bash
# Local benchmark build only: never stages, uploads, or deploys.
set -euo pipefail
cd "$(dirname "$0")/../.."
export MAX_CPU_THREADS="${MAX_CPU_THREADS:-8}"
export WEBGPU_WORKERS="${WEBGPU_WORKERS:-1}"
export PATCH_CACHE_MIB="${PATCH_CACHE_MIB:-128}"
export RUNTIME_BASE="${RUNTIME_BASE:-https://storage.googleapis.com/flywire-frontend/bundle-onnx/ort-conv3d-82e7a1d722d0/}"
export BUILD_INFO="$(node --input-type=module <<'JS'
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const git = (...args) => execFileSync('git', args, {encoding:'utf8'}).trim();
const commit = git('rev-parse','HEAD');
console.log(JSON.stringify({
  commit, tag:git('describe','--always','--tags'),
  url:`https://github.com/seung-lab/neuroglancer/commit/${commit}`,
  timestamp:new Date().toISOString(),
  trackedDiffSha256:createHash('sha256').update(git('diff','HEAD','--')).digest('hex'),
  benchmark:{runtime:process.env.RUNTIME_BASE,maxCpuThreads:Number(process.env.MAX_CPU_THREADS),
    maxWebGpuWorkers:Number(process.env.WEBGPU_WORKERS),patchCacheMiB:Number(process.env.PATCH_CACHE_MIB)},
}));
JS
)"
npm run build -- --no-typecheck --no-lint \
  --define "STATE_SERVERS=$(node -p 'JSON.stringify(require("./config/state_servers.json"))')" \
  --define "NEUROGLANCER_CUSTOM_INPUT_BINDINGS=$(node -p 'JSON.stringify(require("./config/custom-keybinds.json"))')" \
  --define NEUROGLANCER_SEGMENT_LIST_COLOR_WIDGET=true \
  --define "NEUROGLANCER_INFERENCE_MAX_CPU_THREADS=$MAX_CPU_THREADS" \
  --define "NEUROGLANCER_INFERENCE_MAX_WEBGPU_WORKERS=$WEBGPU_WORKERS" \
  --define "NEUROGLANCER_INFERENCE_PATCH_CACHE_MIB=$PATCH_CACHE_MIB" \
  --define "NEUROGLANCER_INFERENCE_WASM_BASE=$(node -p 'JSON.stringify(process.env.RUNTIME_BASE)')" \
  --define "NEUROGLANCER_BUILD_INFO=$BUILD_INFO"
printf '%s\n' "$BUILD_INFO" > dist/client/version.json
