#!/usr/bin/env bash
# Builds ng-onnx assets only; never uploads or promotes traffic.
set -euo pipefail
cd "$(dirname "$0")/../.."
if [[ -n "$(git status --porcelain)" ]]; then
  echo "ng-onnx builds require a clean working tree; commit changes first." >&2
  exit 1
fi
export RUNTIME_BASE=https://storage.googleapis.com/flywire-frontend/bundle-onnx/ort-conv3d-5420599da745/
BUILD_INFO="$(node --input-type=module <<'JS'
import {execFileSync} from 'node:child_process';
const git = (...args) => execFileSync('git', args, {encoding:'utf8'}).trim();
const commit = git('rev-parse','HEAD');
console.log(JSON.stringify({
  commit, tag:git('describe','--always','--tags'),
  url:`https://github.com/seung-lab/neuroglancer/commit/${commit}`,
  timestamp:new Date().toISOString(), branch:git('branch','--show-current'),
  benchmark:{runtime:process.env.RUNTIME_BASE,maxCpuThreads:8,maxWebGpuWorkers:2,patchCacheMiB:384},
}));
JS
)"
export BUILD_INFO
npm run build -- --no-typecheck --no-lint \
  --define "STATE_SERVERS=$(node -p 'JSON.stringify(require("./config/state_servers.json"))')" \
  --define "NEUROGLANCER_CUSTOM_INPUT_BINDINGS=$(node -p 'JSON.stringify(require("./config/custom-keybinds.json"))')" \
  --define NEUROGLANCER_SEGMENT_LIST_COLOR_WIDGET=true \
  --define NEUROGLANCER_INFERENCE_MAX_CPU_THREADS=8 \
  --define NEUROGLANCER_INFERENCE_MAX_WEBGPU_WORKERS=2 \
  --define NEUROGLANCER_INFERENCE_PATCH_CACHE_MIB=384 \
  --define "NEUROGLANCER_INFERENCE_WASM_BASE=$(node -p 'JSON.stringify(process.env.RUNTIME_BASE)')" \
  --define "NEUROGLANCER_BUILD_INFO=$BUILD_INFO"
printf '%s\n' "$BUILD_INFO" > dist/client/version.json
