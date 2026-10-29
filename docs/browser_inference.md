# Local browser ONNX inference

Open **Local ONNX Inference** from the command palette. On the experimental
`experiment/bundled-nooverseg-model` branch, the dialog offers the default
original nooverseg model at an external HTTPS URL; no file selection is required.
Opening the dialog does not download a model or initialize ONNX Runtime.
Click **Load model URL** to load the default model.
The full-width **Model URL (.onnx)** field is prefilled with the default URL;
long URLs wrap, and the multiline field grows automatically to show them.
To use another compatible model, replace it with that model's HTTPS URL
and click **Load model URL**. There is no local-file picker; model bytes stay in
the browser and the model URL is included in shared inference state.
Inference uses a lazy, dedicated ONNX Runtime Web worker with selectable WebGPU
or CPU (WASM) execution;
no Python or inference server is involved. Normal source-data requests still
occur. The runtime and its matching WASM asset are loaded only when a model is
loaded, not on ordinary viewer startup or merely opening the dialog. The unchanged
production `ng-onnx` deployment uses an isolated viewer and up to eight CPU
threads, with a relaxed-header middleauth helper for Google login. The separate
`bundle-onnx` deployment retains its existing four-thread cap.
See [CPU inference performance](#cpu-inference-performance)
for deployment requirements and measurements.

## Deployment

The ONNX viewer is deployed to App Engine service **`ng-onnx`** in project
`seung-lab`: <https://ng-onnx-dot-seung-lab.appspot.com/>.
The versioned [deployment skill](../.pi/skills/ng-onnx-deploy/SKILL.md) covers
production build flags, staging, native runtime assets, auth-compatible headers,
browser verification, traffic promotion, and rollback. In Pi, run `/reload`
and then `/skill:ng-onnx-deploy` to reuse it. Deployment requires explicit
permission; loading the skill alone does not authorize a release.

**Production `ng-onnx`** uses `appengine/ng-onnx/app.yaml`: strict viewer and
worker isolation headers, with a relaxed `/middleauth.html` helper exception.
Its build explicitly defines `NEUROGLANCER_INFERENCE_MAX_CPU_THREADS=8`.
Other builds default to a four-thread cap; nonisolated pages still use one.

**TEST `bundle-onnx`** at <https://bundle-onnx-dot-seung-lab.appspot.com/> retains
its existing deployment and four-thread cap, using
`appengine/bundle-onnx/app.yaml`. Existing shared links remain supported.
The helper checks do not claim that full OAuth login has been completed.
App Engine service names cannot be changed in place. The separate `onnx-test`
service and development-server header policy are unchanged.

## Default external model experiment

The default original nooverseg model, `model300000.onnx`, is fetched directly
from this external HTTPS URL:

<https://storage.googleapis.com/zetta-research-kisuk/hammerschmith_mouse_mec/DeepEM/experiments/260225-MEC-finetune-v1-mec+cutout1-8nm-updown2x-no-overseg-x0/models/aff3_mye1/model300000.onnx>

The download uses CORS (`mode: "cors"`, `credentials: "omit"`); the external
server must permit the viewer's origin. No model bytes are shipped in JavaScript,
under `/app/models/`, or as Google App Engine static assets. The browser verifies
the full original **42,520,250 bytes** (about 41 MiB) and SHA-256
`0493be1d38f98236a4782404e616569b5838020a5a892de429d30a5372285860`
before passing them to the inference worker. There is no split packaging,
quantization, or reduced model.

Ordinary viewer startup without a saved inference layer does not download the
model or initialize ONNX Runtime. Restoring a saved inference layer downloads its
recorded model and reconstructs the prediction locally.
The first opening of the inference dialog only prefills the default URL; loading
starts when you click **Load model URL**. Errors are shown in the dialog and loading
can be retried. Automatic saved-layer restoration is unchanged. Availability depends
on the external server, network and CORS configuration; normal HTTP caching applies.
Loaded bytes are reused for worker/provider reloads within the session. Loading
another model URL cancels an in-progress download. To retry or return to the default
model, use its URL in **Model URL (.onnx)** and click **Load model URL**. Loading
the default URL uses the same verified default-model handling, reusing loaded bytes
when available. Model loading analyzes recognized exports for verified
WebGPU fixes. New inference configurations leave those fixes off until explicitly
enabled; CPU always uses the original bytes.

Custom URLs must use HTTPS (HTTP is allowed only on localhost/loopback for testing),
with no embedded username/password. Their servers must permit anonymous CORS
requests from the viewer's origin. Models must be self-contained ONNX files within
the existing 256 MiB limit and match the tensor contract below. The browser
records the downloaded model's byte count and SHA-256 alongside its URL; shared
pages verify them and fail visibly if the URL's contents change. Recipients need
continued access to that URL; private or expiring links are not durable shares.

The external default removes the recipient's need to possess a local model file.
Inference layers save their recipe in viewer JSON and can be restored from shared
links. Geometry and training-profile confirmation requirements still apply when
creating a recipe; sharing does not establish training suitability. Source values
are passed unchanged after float32 conversion, with no normalization or affine
scale/offset controls.

## Execution provider

Choose **Auto** (default), **WebGPU**, or **CPU (WASM)** before loading a model:

- **Auto** checks for WebGPU and a hardware adapter in the inference module
  worker, requiring a secure context (HTTPS or localhost). Unavailable or
  explicitly software/fallback adapters (such as SwiftShader) select CPU with a
  visible reason. GPU session initialization failures also retry CPU.
- **WebGPU** requires that hardware adapter and disables ONNX Runtime's implicit
  CPU kernel fallback (`session.disable_cpu_ep_fallback=1`). Unsupported kernels,
  device failures, or unavailable WebGPU fail visibly; this mode never silently
  runs the graph on CPU. Support depends on the browser, adapter, and model.
- **CPU (WASM)** bypasses GPU detection and uses the existing CPU execution path.

Auto also retries CPU if the **first real GPU execution** fails. The CPU retry
must itself execute successfully and pass profile/finite-output validation
before anything is published. Invalid model profiles, source-read errors,
cancellation, and malformed/non-finite successful outputs are not treated
as GPU fallback. After the first successful execution, later GPU execution
failures stop the job rather than changing providers midway through published
work. Cancellation terminates the worker; a later run/tile reloads the downloaded
model with the **same requested selection**, potentially selecting a different actual
provider if conditions changed.

The dialog reports the requested selection, last initialized actual provider,
any CPU fallback reason, model compatibility analysis, and opt-in in-memory preparation when applied. These refresh on worker reloads and first-run
fallback, including when the dialog is reopened. Before first execution,
initialization alone does **not** prove that all model kernels can run on GPU.
Changing the selection reloads the current downloaded model, invalidates
confirmation and any live result/cache, and requires settings to be reconfirmed. Stop an active
job/live session to edit the selector.

The worker uses ONNX Runtime Web **1.31.1**'s `onnxruntime-web/webgpu`
entry with the **native WebGPU** backend and matching
`ort-wasm-simd-threaded.asyncify.mjs` / `ort-wasm-simd-threaded.asyncify.wasm`
assets. Both FP32 and optional FP16 use this backend; there is no JSEP runtime.
CPU uses the same runtime's WASM provider. Assets are served same-origin,
including under `/app/`; no CDN runtime assets are used.
WebGPU explicitly requests `preferredLayout: "NCHW"` and disables implicit CPU
kernel fallback. ORT owns its device and negotiates its features. This runtime
includes native Conv3D support absent from the previously tested 1.24.3 native
backend. The migration follows ORT's [JSEP deprecation guidance](https://github.com/microsoft/onnxruntime/pull/32357#issuecomment-5503588313).
GPU outputs are CPU float32 tensors for the existing crop/stitch and ordinary
Neuroglancer CPU/GPU rendering caches. There is no graph capture or GPU-resident
I/O binding.

## Experimental FP16 GPU inference

**Experimental FP16 GPU inference** is an opt-in checkbox, off by default.
FP32 remains the default and every CPU execution uses the original FP32 model.
Changing precision reloads the downloaded original bytes, clears confirmation
and live results/patch caches, and requires confirmation again. The selection
is saved in the shared recipe; old recipes without it still request FP32.
The dialog and result metadata distinguish requested and actual precision and
show any FP32 fallback reason, including after first execution or worker reload.

Explicit FP16 selection attempts conversion for any model, without a recognized-model
or fingerprint requirement. Floating-point graph values and weights are converted
in the worker to IEEE FP16 with nearest-even rounding, without clamping;
integer/shape tensors are unchanged. Boundary casts preserve public FP32
input/output, shapes and channel count. This is not a general ONNX converter:
unsupported structures (including existing Casts, subgraphs and external FLOAT
tensors) or incompatible operators may still fail conversion or execution and
trigger a visible FP32 fallback. The original is neither modified nor uploaded.
FP16 conversion is separate from the optional verified FP32 compatibility bundle;
a precision retry uses that bundle only if selected.

The worker checks its hardware adapter for **`shader-f16`**. Missing support,
conversion/session initialization failure, or a failure of the first FP16 model
execution retries FP32 WebGPU with a visible reason. If that also fails, the
existing provider policy applies: Auto may fall back to original-model FP32 CPU;
strict WebGPU never silently switches to CPU. Successful but malformed/non-finite
outputs are rejected, not used as a reason to hide a failure with a retry.
Later execution errors stop the job rather than mixing precisions in published
results. Finite but inaccurate FP16 predictions **cannot be detected automatically**.

Chrome does not expose `shader-f16` on every GPU/driver. The web page cannot enable
Chrome flags. On the previously tested NVIDIA/Chrome setup, a separate experimental
Chrome launch with `--enable-dawn-features=vulkan_enable_f16_on_nvidia` exposed it;
that driver workaround bypasses a Dawn safety gate and is not a portable or
recommended default. The option safely requests FP32 when the feature is absent.

FP16 changes arithmetic, not just storage. The prior eight-patch model6280000
microbenchmark on RTX 3090 found roughly 1.5× faster native FP16 but retained-output
maximum absolute error about **0.029** and mean absolute error about **0.00058**
against native CUDA FP32. Those are synthetic-test measurements, not accuracy
acceptance criteria or segmentation validation. A separate two-input check of the
original default nooverseg model through the built worker found a retained-output
maximum absolute difference about **0.183** and mean about **0.0087** versus FP32
CPU on one synthetic input. Even finite FP16 results can differ substantially.
Keep FP32 unless the model owner has validated FP16 on representative real data.

## CPU inference performance

CPU inference uses ORT's SIMD-enabled WASM backend in a dedicated worker. The
worker uses an isolation-dependent thread setting:

```js
numThreads = globalThis.crossOriginIsolated
  ? Math.max(1, Math.min(maxCpuThreads, navigator.hardwareConcurrency || 1))
  : 1;
```

`maxCpuThreads` defaults to four. The `ng-onnx` production build sets
`NEUROGLANCER_INFERENCE_MAX_CPU_THREADS=8`; it uses at most eight threads and
never more than the browser-reported logical CPU count. The CPU provider status
and worker load/output metadata report this configured count. Nonisolated pages
use one thread; missing or invalid-low logical CPU counts also fall back to one.
This is a maximum pool size, not a guarantee that every operator saturates every
core. No thread-pool setting in Python or
native ORT affects this browser backend. This does not change the native WebGPU
runtime, GPU execution, or optional FP16 support.

### Isolated `ng-onnx` and `bundle-onnx` with middleauth helper

The authorized `ng-onnx` eight-thread rollout reuses the existing `bundle-onnx`
helper design. Both deployment configurations use the following default headers
on viewer and worker assets:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Verify `window.crossOriginIsolated === true` and the expected capped thread count
in load and output metadata. HTTPS (or localhost), SharedArrayBuffer and a
threaded runtime are required. External model/volume resources must be permitted
by CORS or CORP under the strict embedder policy; other authenticated providers
need separate validation. The development-server header policy is unchanged.
The `/middleauth.html` exception instead uses
`same-origin-allow-popups` / `unsafe-none` and is nonisolated. Strict viewer COOP
can sever a cross-origin Google popup's opener. For **middleauth only**, the
isolated viewer opens the same-origin helper and receives the result over
`BroadcastChannel`; the helper's relaxed policy preserves its Google popup's
opener for the existing response. The helper requires an extra **Sign in with
Google** click to open that popup with a fresh user gesture. Each attempt uses a
random channel, validates the callback's origin and popup source, and cancels on
abort, closure, or timeout. Isolated helper credentials stay in memory rather
than the legacy localStorage cache. Other authentication flows are unmodified;
this helper is not a general solution for every provider under strict isolation.

Run `BASE_URL=https://ng-onnx-dot-seung-lab.appspot.com/ node tests/inference/auth_helper_production.mjs`
to check the relevant headers, the full synthetic credential relay, the real
Google popup's opener, wrong-origin rejection and cancellation cleanup. It does **not** complete account OAuth or prove that
full Google login works end to end. Actual sign-in still requires separate
verification with an authorized account. The CPU numeric/replay smoke described
below independently verifies the isolated inference path; passing it is not an
authentication result.

### Historical CPU thread benchmark

A local Chrome 153 / ORT Web 1.24.3 benchmark on an Intel i7-9800X (16 logical
CPUs) used the original 42.5 MB `nooverseg.onnx`: float32 input
`[1,1,20,80,80]`, output `[1,4,20,80,80]`. Each thread count used a fresh module
worker, one warmup, then two timed `session.run` calls with the same deterministic
input. Download, initialization, preprocessing, stitching and validation were
excluded. Mean warm execution times:

| WASM threads | Time per patch | Speedup over one thread |
| ------------ | -------------- | ----------------------- |
| 1            | 8.23 s         | 1.00×                   |
| 2            | 4.78 s         | 1.72×                   |
| 4            | 2.95 s         | 2.79×                   |
| 8            | 2.53 s         | 3.26×                   |

All 512,000 output values were finite and identical across these runs. This is a
small, single-machine microbenchmark, not an end-to-end latency guarantee.
Eight threads improved on four by about 14%. These historical multithreaded
measurements do not benchmark the current native 1.31.1 experiment or the
unchanged single-threaded production service.

### Other CPU optimization candidates

A separate four-thread run used a fresh original-model baseline (3.14 s/patch)
and the same warmup/two-run method and deterministic input:

- **Historical prepared model:** the retired ConvTranspose3D-to-ConvTranspose2D
  rewrite ran in 2.42 s (23% less time, 1.30× speedup), with all output values
  identical. That rewrite is no longer applied by compatibility fixes or the
  offline command; these numbers do not benchmark the current padding-only fix.
- **Memory reuse options:** enabling both `enableCpuMemArena` and
  `enableMemPattern` gave 3.02 s (about 4% less time), also with identical outputs.
  This small sample is insufficient to justify changing defaults or accepting
  potential additional memory retention.
- **Reduce repeated patches:** the existing overlap toggle uses half-input
  strides when enabled. Disabling overlap reduces model calls; with full-size
  retained output this approaches 8× fewer patches for a large 3-D region.
  Actual savings depend on cropping and boundaries, and seam quality can suffer.
- **Avoid redundant computation:** inference already has a 128 MiB prediction
  patch cache, live requests deduplicate pending tile jobs, and normal viewer
  chunk caches retain output tiles. Keep model/settings stable to benefit;
  changes invalidate those results. Live tiles also reuse the loaded session.
- **Graph optimization and SIMD:** these are already enabled by the installed
  runtime (`graphOptimizationLevel` defaults to `all`); setting them again is not
  an additional optimization. An offline ORT-format model may reduce loading and
  initialization, but does not imply faster steady-state kernels.
- **Quantization:** INT8 can help some CPU models, but requires an exported model,
  supported WASM kernels and representative segmentation-quality validation.
  Dynamic quantization is not a safe automatic optimization for this Conv3D
  network. FP16 is not a guaranteed WASM CPU speedup either.
- **Native CPU execution:** moving inference to a native ORT service allows
  native threading/provider tuning, but adds deployment, data-transfer and
  privacy tradeoffs. It is not a browser configuration switch.

See ORT's [Web performance guidance](https://onnxruntime.ai/docs/tutorials/web/performance-diagnosis.html)
and [Web environment flags](https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html).

## Supported baseline

Input/output names, spatial shapes and output channel count are inferred from
ONNX Runtime metadata, not fixed to the default model. Supported models have exactly
one float32, batch-one **NCDHW** input with one channel and one float32, batch-one
NCDHW output with one or more channels. All dimensions must be concrete positive
integers within the tensor/result memory limits; symbolic shapes, other layouts,
multiple inputs/outputs and multichannel inputs are rejected.

The **Input scale X Y Z** selector lists the image source's available resolutions
in **X Y Z** order, including physical units. It defaults to scale 0 (the finest
available scale); it does not choose a scale automatically from model metadata
or zoom. Selecting another scale reads that scale's actual chunks without
resampling and clears geometry confirmation. Source changes reset the selection.
The current input voxel size readout and output voxel size field also use XYZ.
**Output voxel size X Y Z** is editable, in the native physical units shown for
the input. Selecting an input scale automatically fills it with that scale's
voxel size, even before a model is loaded. This default does not depend on the
model's input/output shapes. Selecting another input scale replaces any manual
output voxel size edit. Verify or change the output spacing to match the model's
training geometry before confirming.
Input is read on the selected scale's native grid without resampling. The model itself produces any finer
output sampling. Geometry assumes centered input/output voxel fields:
`rawOutputOrigin = ((inputShape - 1) * inputSpacing - (rawOutputShape - 1) * outputSpacing) / 2`.
Unsupported fractional patch placement or gaps between retained patches are
rejected rather than rounded or filled.

For example, selecting input **32×32×45 nm** automatically fills output
**32×32×45 nm** (`3.2e-8,3.2e-8,4.5e-8` when the displayed units are m).
A model with input `[1,1,16,128,128]`, output `[1,1,48,128,128]` and input
XYZ `16×16×45 nm` may instead require output XYZ **16×16×15 nm** to preserve
its input patch's physical extent. Enter this explicitly as `16,16,15` if the
displayed units are nm, or `1.6e-8,1.6e-8,1.5e-8` if they are m.
Model tensors, geometry arrays and saved recipe spacing remain in ZYX order.
With that explicit output spacing, the centered raw output begins one output Z
voxel before the input origin.
Cropping each face by `[6,16,16]` ZYX retains **36×96×96** ZYX (96×96×36 XYZ),
with a single raw output channel. Model kernel support still depends on the
chosen provider; accepting a shape does not guarantee GPU execution.

The original nooverseg model remains supported. Verified WebGPU preparation is
scoped to recognized model fingerprints, as described below; unknown models are
not silently converted.

Use one scalar rank-three image source with unambiguous `x`, `y`, `z` dimensions,
explicit physical metadata, and a supported native grid at the selected scale. Unsupported
transforms, channels/time dimensions, ambiguous sources, and resampling are
rejected rather than guessed. Predictions preserve every float32 output
channel reported by the model. There is no softmax, argmax, or instance segmentation. Channel names and
normalization are not established merely by inspecting ONNX node names.

Confirm the native input voxel size, axis mapping and output geometry before
starting live inference. Source samples are converted to float32 and otherwise
passed unchanged: no normalization, intensity scale/offset, or resampling is
applied. Non-finite float32 input values are rejected before model execution.
Models must accept these raw source values; any required normalization must
already be represented by the model or source dataset. The model owner must
confirm compatible input values, voxel size and channel semantics. A finite model
output is not proof of semantic correctness.

## Optional legacy JSEP padding fixes

After loading, **Model compatibility analysis** identifies recognized exports by
SHA-256 and lists their verified padding fixes. **Apply legacy JSEP padding fixes**
provides workarounds for the older JavaScript WebGPU backend, not general WebGPU
requirements. They are not required for the default model on the tested native
runtime. This checkbox is off for new configurations. Enabling or disabling it
reloads the current model from its cached original bytes and clears confirmation;
stop active inference before changing it.
The toggle changes only supported Conv padding attributes; native 3-D
ConvTranspose operations and their weights are preserved.

Recognized original models:

- `nooverseg.onnx`: SHA-256
  `0493be1d38f98236a4782404e616569b5838020a5a892de429d30a5372285860`.
  Its optional FP32 fix changes 34 supported Conv padding attributes; provenance
  reports the historical recipe name `nooverseg-jsep`.
- The verified `model6280000.onnx` export: SHA-256
  `2c19eac209030e9f1d3b52d6dfaa72a509291f8644ca0e36fbe22231f2baac3c`.
  Its fix changes 37 Conv padding attributes without rewriting ConvTranspose;
  provenance reports the historical recipe name `model6280000-jsep`, not the
  runtime backend.
  This is the single-channel model with input
  `[1,1,16,128,128]` and output `[1,1,48,128,128]`.

Analysis recognizes these exact byte fingerprints; it is not a general operator
compatibility checker. Unknown files are explicitly **unverified** and are never
rewritten speculatively. Recognized prepared files pass through unchanged.
Preparation runs in the dedicated worker, verifies its resulting fingerprint,
never modifies or uploads the original bytes, and needs no Python/server.
CPU and every Auto CPU retry use the original model, regardless of the checkbox.
These bundles retain their historical `jsep` identifiers for shared-state
compatibility; all GPU execution now uses native WebGPU. Recognizing a verified
padding recipe does not mean the native backend requires it. A successful
analysis does not guarantee browser/device kernel support.

The explicit `compatibilityFixes` boolean is saved in URL recipe state, so
recipients and cancellation/reload paths use the same selection. Old shared recipes
without this field retain the historical automatic preparation of the original
nooverseg export only; they do not implicitly enable the newer model's bundle.

### Optional offline command

The standalone command is still available to export a separate prepared file.
Keep the original model as your reference. The tool requires Python 3.11+ with
**tool-only** `onnx` and `numpy` (tested with ONNX 1.23.2); these are not new
application dependencies. Use a Python environment that already has them:

```sh
python build_tools/prepare_nooverseg_jsep.py /path/to/nooverseg.onnx /path/to/nooverseg-jsep.onnx
python -m unittest build_tools.prepare_nooverseg_jsep_test -v
```

The standalone tests additionally use `onnxruntime` for numeric CPU comparison
(the numeric test is skipped if it is unavailable). No browser or user model is
needed for those tests. The command refuses an existing output, including aliases
of the input, and never modifies the original. It validates the fixed float32
`input [1,1,20,80,80]` / `output [1,4,20,80,80]` profile, default-domain opset 10,
static inferred shapes, and the relevant attributes and initializer weights.
Mismatches fail visibly without publishing a prepared model. This is not a
general converter for arbitrary models or profiles.

Only this semantics-preserving rewrite is made:

- Conv3D odd kernels, stride/dilation 1, group 1, and exactly matching symmetric
  pads become `auto_pad=SAME_UPPER`. Kernels, weights, biases and outputs are
  unchanged; unsupported padding is rejected, not approximated.

ConvTranspose nodes, initializer tensors and graph topology remain unchanged.
The tool runs ONNX checker and strict shape inference before/after preparation
and writes a separate self-contained model. Synthetic CPU comparisons validate
padding equivalence, not every possible input or real-image accuracy.

In Chrome on a secure page with hardware WebGPU, choose **WebGPU** and enter a
URL serving `nooverseg-jsep.onnx`. Reconfirm source geometry and settings, then
click **Start live**. Check that the reported actual
provider is WebGPU after a successful execution; initialization alone is not
enough. Strict WebGPU never silently substitutes CPU. **Auto** keeps its existing
fallback behavior. A URL can serve either the recognized original (prepared in
memory when its verified fixes are enabled) or an already-prepared file. Model data is never uploaded.
This experimental branch also loads the original model from the default external
HTTPS URL, as described above.

## Output cropping and blending

Public inference is live visible slices only, with no mode selector or explicit
ROI controls. Internally, each demanded display tile still calls `controller.run`
with an output box: `originZYX` and `shapeZYX` specify its origin and extent in
output voxels in Z,Y,X order, not an input-patch bounding box or viewport screenshot. This
internal output-box/geometry API is not a separate UI execution mode.

The worker crops **12.5% of each raw output dimension from each face**, rounded
down to whole voxels, before
transfer. Thus raw `[48,128,128]` retains `[36,96,96]`; the default model's raw
`[20,80,80]` retains `[16,60,60]` with the previous `[2,10,10]` crop unchanged.
**Overlap and blend output patches (chunkflow)** is unchecked for new UI sessions.
With it enabled, input patches use **half-input stride**, anchored globally at the
prepared dataset origin, not at the requested display chunk. The model's input
dimensions must support this integer stride. Output stride is `inputStride * inputSpacing / outputSpacing`;
for the finer-Z example it is `[24,64,64]`, giving retained overlap `[12,32,32]`.
After cropping, all predictions covering each output voxel are combined using
the exact **Chunkflow wu** patch mask independently per channel; provenance records
`blending.method = "wu"`. There is no further channel normalization or selectable
taper setting. The default model still uses stride `[10,40,40]` and overlap
`[6,20,20]` ZYX.

Leave **Overlap and blend output patches (chunkflow)** unchecked to place cropped
output patches at a stride equal to their retained shape, copying each prediction directly with
**no blending** (`blending.method = "none"`). The default model then uses ZYX
input/output stride `[16,60,60]`; the finer-Z model uses input stride
`[12,96,96]` and output stride `[36,96,96]`. These are output-patch strides, not
raw output shapes or display-chunk sizes. The input stride is
`retainedOutputShape * outputSpacing / inputSpacing` and must align to whole
input voxels; incompatible geometry is rejected rather than resampled. The
source-anchored grid and valid-context-only boundary policy still apply. Disabling
overlap may reduce the valid high-edge extent because fewer full input contexts
fit. Patch-dependent models may show seams without blending.

The mask used when blending is enabled follows Chunkflow's
`chunkflow/chunk/image/convnet/patch/patch_mask.py` at revision `5aaa7504e2c44f5a89d611d002160e4c8af76d2f`:

1. For each retained-patch axis of length `n`, index `i` uses
   `u = 2 * (i + 1) / (n + 1) - 1` (not endpoint-inclusive coordinates).
2. Form the float64 3-D bump
   `b = exp(-1/(1-ux²) - 1/(1-uy²) - 1/(1-uz²))`.
3. Affinely map the **global 3-D** bump minimum/maximum to `[1, 1e6]`:
   `a = 1 + (b - min(b)) * (1e6 - 1) / (max(b) - min(b))`.
   This is not a product of independently rescaled 1-D windows.
4. Add `a` at all 27 placements on a `3×3×3` lattice with output stride
   given by the model's output stride, divide `a` by the central patch-sized region
   of that sum, then cast to float32. For the default model these are stride
   `[10,40,40]`, retained shape `[16,60,60]` and overlap `[6,20,20]`.

Each controller caches one float32 Wu mask, keyed by retained patch shape and
output stride, for reuse across live chunks. A changed key
replaces the mask; controller disposal releases it. Overlap-disabled runs skip
mask generation. Per-result accumulated weights are still computed from the
actual contributing patches, not cached.

Accumulate `prediction * maskWeight` and `maskWeight` for every actually
available source-valid context, then divide each voxel/channel by its weight
sum. This final available-weight normalization is required at source boundaries,
where some periodic neighbors do not exist; do not assume the weight sum is one.

Every full source-valid input patch whose retained output intersects a requested
display chunk contributes, including crops extending outside that chunk. Only
the contribution written to the display chunk is clipped; inputs and worker crops
remain full-size. The valid output union's origin follows the physical voxel-center
formula below and its per-axis shape is
`retainedOutputShape + floor((datasetShape - inputPatchShape) / inputStride) * outputStride`.
No implicit padding or zero-filled unknown predictions are performed. A dataset
smaller than one full context patch is rejected.

Patches run sequentially. Only complete, still-current display chunks are
published. Source changes/reset/disposal invalidate the session.

## Live visible slices

Confirm the source, model profile, native input voxel size and output geometry,
then click **Start live**. Raw source values are passed unchanged after float32
conversion. No manual ROI is used. A normal
`inference://` image datasource computes only tiles requested by the result view,
including ordinary view prefetch if enabled. Panning requests new tiles; cached
CPU/GPU chunks are reused under the viewer's normal memory budgets. Zoom changes
which tiles are visible, **never** the model input voxel size. Large views can be
expensive because all inference remains at the confirmed native resolution.

The fixed global output grid has XYZC chunks `[60,60,16,C]`, where `C` comes from
the model. It is anchored to
the prepared native dataset origin, not to a viewport/screen-pixel rectangle or
the last requested chunk. Display chunks are separate from the model patch
lattice: with overlap enabled each chunk wu-blends all contributing model-sized
context patches on the source-anchored half-input stride described above. With
overlap disabled it directly copies the intersecting nonoverlapping retained
patches instead. Display chunk size remains unchanged in either mode. Placement of
each cropped model output follows physical voxel-center geometry:
`outputOrigin = (inputOrigin * inputSpacing + rawOutputOrigin) / outputSpacing + cropBefore`.
Axis mapping and translated dataset origins come from the prepared input;
input spacing comes from native source metadata and output spacing is explicitly
confirmed by the user. Anisotropic spacing and nonzero origins are retained.

Boundary policy is an **explicit valid domain**, with no padding: the first
output starts at the physical cropped-output origin (dataset origin + ZYX
`[2,10,10]` for the default equal-resolution model). Compute the full valid cropped
output union as above, then publish only full display chunks: on each axis the
live shape is `floor(validOutputShape / displayChunkShape) * displayChunkShape`,
with ZYX display chunks `[16,60,60]`. For example, source shape `[53,201,261]`
has valid output union shape `[46,180,220]` and live shape `[32,180,180]`.
The low halo, high halo, and any incomplete high-edge display chunk are outside
the result bounds (transparent/missing, not fabricated zero predictions).
**All** source-valid patches intersecting a displayed chunk still contribute,
even when their retained crop extends beyond the published live bounds. This
keeps adjacent live chunks consistent with one combined weighted computation,
despite InstanceNormalization making predictions depend on the patch anchor.

Overlap requires more model executions than nonoverlapping retained blocks.
A per-controller, 128 MiB LRU cache retains cropped model patch
predictions in CPU memory. Neighboring display chunks reuse shared predictions
without rereading or rerunning those patches; each chunk still applies the same
wu blend in the same contributor order, or directly copies patches when overlap
is disabled. The cache is scoped to the prepared
input, overlap setting and output geometry and cleared on
model/provider selection, cancellation, worker failure, or disposal. Evicted patches are recomputed on
demand. This transient cache is not serialized in shared URLs. Published CPU/GPU
display chunks still use the normal viewer cache. Inference runs sequentially
on either provider.
Duplicate in-flight chunk requests share work; queued requests
with no remaining demand are removed. Demand-lost active work aborts source reads
and terminates the worker; the downloaded model is reloaded for the next tile.
There is no worker FIFO or volume-sized prediction cache. Pending tile
metadata is capped at 128 jobs; exceeding it reports a chunk error rather than
allocating in proportion to the volume. Derived downloads and native input
reads use independent scheduler capacities, avoiding dependency slot deadlock;
sequential native reads bound the impact of the input fetch bridge's high
priority. No volume-sized tensor or eager whole-volume scan is allocated.

**Stop live** removes the derived layer and cancels work. Deleting its layer also
stops the session. Source/model changes, reset and viewer disposal invalidate
queued/running work; stale responses cannot publish into a replacement layer.
A real inference/read failure stops the live layer, is retained in the dialog,
and raises a visible notification even if the dialog is closed.
Closing the dialog alone does not stop inference. To change settings, stop,
edit, reconfirm and start a new session; cache identity never includes viewport
position. Saved live layers restart from their serialized recipe after reload.

## Result view and lifetime

The prediction opens as a normal image layer in an adjacent
layer-group view. Root-linked navigation and supported relative links preserve
ongoing correspondence with the source. Any unlinked source-group navigation is
rejected before inference and checked again before publication: link source
navigation first. Independent snapshot panels are not a fallback. Existing
layout selections and navigation are preserved; no source group is relinked
automatically. The `c^` channel
dimension exposes the model's channels through normal image-layer controls.
A single-channel model needs no channel slider; multichannel models get the
corresponding slider range.
Delete prediction layers to release retained result memory; chunk caches and WASM
working memory are additional to the retained prediction-patch budget.

### Sharing and restoring inference layers

New prediction layers use `source: {url: "inference://recipe", state: {...}}`.
Select a prediction layer and open the right sidebar's **Source** tab to inspect
its **Inference source state (read-only)** JSON panel beneath the source URL.
The syntax-highlighted recipe can be selected and copied, including while the
source is loading or after a restore error. Viewing it does not reload inference.

The source's `state` contains a versioned recipe: the captured input datasource
specification (including its transform/subsource selection), descriptive source
name, model URL(s), exact byte count and SHA-256, requested execution provider,
confirmed native input voxel size, selected `inputScaleIndex`, geometry profile,
the `overlap` boolean, and
`mode: "live"`. Recipes omit the `preprocessing` and `roi` fields. Recipes without
an `overlap` setting retain the previous enabled-overlap/wu behavior. Recipes
without `inputScaleIndex` retain scale 0; restore rejects an unavailable scale
or a scale whose spacing differs from the recorded spacing. New version-2
recipes also save the confirmed output voxel size; the `ncdhw-centered-v2` profile fixes centered geometry,
model-derived shapes/channels and the 12.5%-per-face crop. Version-1 recipes retain
their original exact nooverseg shapes, names, equal spacing and placement; they
never reinterpret a different model as the old profile. The ordinary viewer JSON also retains the image shader,
channel controls, layout and navigation.

Copy/share the page URL or save its JSON state normally. A fresh page reconstructs
the input from the captured specification, downloads and verifies the recorded
model, and recomputes the prediction. Live layers still compute only demanded
tiles. Recipes containing `preprocessing` or `roi`, or a mode other than `"live"`,
are rejected visibly rather than silently migrated. This includes legacy identity
preprocessing (`scale: 1`, `offset: 0`) in either recipe version; recreate these
layers using raw-input live inference. The original input layer's name,
ordering, or continued presence is not required. No model weights, prediction
tensors, worker objects or transient result IDs are serialized. Session IDs remain
an internal runtime cache and old `inference://<id>` links are not recoverable
without a recipe.

The setup accepts model URLs, so both default and custom models produce
URL-backed recipes. Legacy states created with a local-file override still lack
the model bytes; rerun them with a model URL to create a shareable replacement.
They never silently substitute the default model. Recipients also need access to
the input dataset and model server (including authentication/CORS as appropriate).
Sharing may trigger model downloads and local computation; `Auto` may choose a different
provider on another computer, and GPU/CPU results need not be bit-identical.
Restored layers own their runtime independently of the inference dialog; deleting
or replacing the layer, resetting the viewer, or closing the page cancels it.

After building, run `CHROME=/path/to/chrome node tests/inference/share_production.mjs`
for fresh-context URL restoration, all-channel raw-input live values, source-independent
pan, shader/settings preservation, deletion/reset during held input downloads,
and actionable local-model, malformed-recipe and model-integrity failures.

## Validation and limitations

The local original nooverseg model executes with ONNX Runtime Web 1.24.3 WASM,
including Conv3D and InstanceNormalization, producing finite float32
`[1,4,20,80,80]` outputs. The production build was tested in Chrome 153 on an
NVIDIA RTX 3090: the prepared model executed on strict WebGPU and Auto without
CPU fallback. On two synthetic inputs, the CPU rewrite matched exactly and the
largest retained-crop GPU-versus-original-CPU error was **0.00504** (mean
**0.000366**). Earlier full-output proof probes observed maximum error **0.00849**
outside/before cropping. GPU arithmetic is not bit-identical to CPU; these
observations are not universal error bounds or real-image accuracy claims.
No trusted nooverseg training-input specification or training reference has been
provided. The historical numerical measurements below predate the raw-input-only
change; rerun the current smokes to validate the current runtime and input contract.

The historical **nonoverlapping-output** live Chrome UI smoke passed **61 tiles**,
including pan, cache/zoom,
cancellation/retry, Stop/settings replacement, deletion, source change and reset.
The first displayed crop (230,400 values, all four channels) differed from the
original model's CPU output by at most **0.00301**, with mean **0.0000386**.
No-GPU fallback and isolated-page four-thread runtime checks also passed under
the earlier isolation-dependent threading policy. The new precision smoke again
requires the isolation-dependent capped count, while production `ng-onnx` stays
nonisolated at one thread. These historical measurements do not validate the
current wu blend.

Before patch caching, the **wu-blend** production smoke passed on CPU with the
deterministic fixture and on strict hardware WebGPU with the automatically
prepared original model: **1,019 patch executions** across the full lifecycle, with at most one
execution active. The first displayed wu-blended chunk combined **8 contexts**;
all **230,400** values across four channels were compared against an independent
CPU wu-weighted blend of the original model on those same contexts. Observed
maximum absolute error was **0.001607**, mean **0.0000282**. These are
synthetic-fixture observations, not universal error bounds or accuracy claims.

With cropped-patch caching, the deterministic production lifecycle passed on CPU
and strict hardware WebGPU with **525 executions** each, including pan,
cancellation/retry, settings changes, stop/deletion/source/reset, and all-channel
value checks. Initial demand used **18** unique patches instead of **32**
per-chunk executions; the next pan used **105** instead of **210**.

A separate model300000 benchmark on Chrome 153 / RTX 3090 compared caching with
the unchanged, uncached controller on the same four neighboring interior chunks.
Across three repetitions, executions fell from **75 to 48** and median time from
**17.75 s to 11.57 s**. Repeating those chunks from the patch cache took **0.30 s**,
with no input reads or model executions. All **921,600** output values were
bit-identical to the uncached result, including after mutating returned result
buffers. Inputs were deterministic in-memory patches; these timings exclude
source downloads and decoding and are not general performance guarantees.

A separate tiny deterministic ONNX fixture verifies actual worker inference and
all-channel crop/stitch values; its strict hardware-WebGPU output matched WASM
exactly in that historical probe. Because its context predictions are identical,
this fixture cannot distinguish wu from uniform blending: the live smoke allows
weighted floating-point roundoff rather than requiring exact equality. Distinct
context-dependent predictions and Chunkflow mask golden comparisons are needed
to validate wu weighting itself. The tests compare 238 mask samples (including
all 192 voxels of an asymmetric patch) and six contextual blends against
`testdata/inference/wu_bump.json`, generated by executing Chunkflow's actual
Python functions. Regenerate with NumPy installed:

```sh
python testdata/inference/generate_wu_bump.py --chunkflow-root /path/to/chunkflow
```

Unit tests cover anisotropic and unequal-resolution geometry, fractional
alignment rejection, tiling and cancellation. Live blending
unit tests additionally compare adjacent chunks with a combined internal output
box (ROI) using context-dependent predictions in every channel, including
contributors whose crops extend beyond the published high boundary.

For reproducible production/UI coverage, run `npm run build` followed by
`node tests/inference/live_production.mjs` (Playwright Chromium required; set
`CHROME=/path/to/chrome` to use a system browser). This serves a synthetic native
volume with anisotropic spacing and nonzero origins and loads the
`testdata/inference/concat.onnx` fixture through a URL on the local test server.
It checks every value in all four channels, fixed tile placement, four initial tiles and new demand after pan,
cache reuse/zoom, dependency progress with **one** download slot, abandoned-read
cancellation/retry, active Stop/settings replacement, deletion, source change and
reset. The smoke asserts overlap is unchecked by default, then explicitly enables
it for the independent Wu oracle and lifecycle checks. It explicitly selects CPU
by default. `PROVIDER=auto` or
`PROVIDER=webgpu` selects another mode; `LAUNCH_OPTIONS` can supply JSON Playwright
launch overrides for an independently configured hardware-GPU browser. A software
headless adapter is not a hardware acceleration test.

On `experiment/bundled-nooverseg-model`, use `BUNDLED_MODEL=1` to exercise the
same live lifecycle with the **default external URL and no file selection**.
The branch and environment-variable names are retained for compatibility; this
smoke mode no longer means bundled model assets. It observes the real external
network request without intercepting or mocking the download: no model fetch or
worker load on dialog opening, exactly one external GET after clicking
**Load model URL**, no `/app/models/` requests, the default URL in the model field,
and no additional model fetch during provider/worker reloads or the remaining
lifecycle. This mode defaults to Auto; hardware browser configuration
is still required to test WebGPU rather than CPU fallback. For example:

```sh
BUNDLED_MODEL=1 CHROME=/path/to/chrome node tests/inference/live_production.mjs
```

Add `REFERENCE_MODEL=/absolute/path/nooverseg.onnx` for the independent CPU
comparison described below. That reference file is test-only, not selected by
the UI or needed by a recipient.

`node tests/inference/provider_production.mjs` separately checks strict-provider
errors, Auto fallback, session reuse and exact CPU/cropped-output agreement from
the built worker under `/app/`. By default it disables GPU; `HEADFUL=1` requires
working hardware WebGPU instead. Set `CHROME` and desktop environment variables
as needed. Use `ISOLATED=0` for this older harness's single-thread assertions
and the auth-compatible headers used in production `ng-onnx`. For current
isolated multithread configuration, numeric output and replay assertions, use
`precision_production.mjs` below instead. Its optional
`MODEL=/absolute/path/nooverseg.onnx` verifies automatic background
preparation and strict/Auto GPU execution against original-model CPU output on
two inputs. Also set `PREPARED_MODEL=/absolute/path/nooverseg-jsep.onnx` to compare
the prepared model against the original on two inputs: CPU rewrite must be exact;
with `HEADFUL=1`, strict and Auto must both actually execute on hardware WebGPU
with maximum absolute error **≤0.01** and mean absolute error **≤0.001** against
original-model CPU output. Without `HEADFUL=1`, GPU is disabled and Auto must
visibly fall back to CPU with exact reference equality. For example, after the
production build:

```sh
MODEL=/absolute/path/nooverseg.onnx \
PREPARED_MODEL=/absolute/path/nooverseg-jsep.onnx \
HEADFUL=1 CHROME=/path/to/chrome node tests/inference/provider_production.mjs
```

These bounds are regression checks on the selected inputs, not real-image
accuracy validation or universal error guarantees.

For the live lifecycle smoke, `MODEL=/absolute/path/nooverseg.onnx` with
`PROVIDER=webgpu EXPECT_PREPARATION=1` repeats navigation/lifecycle coverage
and asserts automatic preparation of the original model. Without a provider
selection this smoke defaults to CPU and does not prepare. Add
`REFERENCE_MODEL=/absolute/path/nooverseg.onnx` to compare the **first actual
displayed wu-blended chunk** against an independent weighted blend of
original-model CPU outputs for **every contributing context**, using identical
raw float32 source inputs and post-crop placement. The smoke generates its own
float32 wu mask by literally reproducing Chunkflow's 3-D bump, affine min/max
mapping and `3×3×3` overlap addition; it does not import application geometry or
mask code. Weighted sums and available-weight sums use float64, including at
boundaries. It applies the same maximum **≤0.01** /
mean **≤0.001** absolute-error bounds. Without a reference model this checks finite outputs and
lifecycle only, not numerical reference agreement. `SCREENSHOT=/tmp/inference.png`
saves the adjacent source/result views. For hardware Chrome coverage, use a
working desktop/browser setup and `PROVIDER=webgpu`, for example:

```sh
MODEL=/absolute/path/nooverseg.onnx \
REFERENCE_MODEL=/absolute/path/nooverseg.onnx \
PROVIDER=webgpu EXPECT_PREPARATION=1 SCREENSHOT=/tmp/inference.png \
CHROME=/path/to/chrome \
LAUNCH_OPTIONS='{"headless":false,"ignoreDefaultArgs":["--enable-unsafe-swiftshader"],"args":["--no-sandbox","--enable-unsafe-webgpu"]}' \
node tests/inference/live_production.mjs
```

On a Wayland desktop, also pass `--ozone-platform=wayland` in the launch arguments
and set `WAYLAND_DISPLAY` / `XDG_RUNTIME_DIR` for that desktop session.

Both the real-model and deterministic live smokes pass raw source values unchanged
after float32 conversion; their CPU oracles use the same raw inputs. This is a
synthetic-input regression check, **not** a claim about training suitability.
The default smoke explicitly loads its fixture URL from the local test server
without uploading it or starting a default-model download. The `BUNDLED_MODEL=1`
variant explicitly loads the real external default URL just as a new user would,
without selecting a file. Saved-recipe recipients still load automatically.
The optional CPU reference is served separately by the local test server.

`node tests/inference/precision_production.mjs` exercises the real dialog,
production worker and native Asyncify assets with a raw-input deterministic numeric
oracle. Its source has exactly one full model input context; retained output is
96×96×36 XYZ, and it checks every voxel in demanded full 60×60×16 XYZ live chunks.
It checks FP32 defaults, FP16-to-FP32 fallback, public FP32 tensors, precision
status, copied live recipe replay and old live recipes without a precision field.
Runtime WASM content-type and hash checks distinguish native Asyncify from JSEP.
`HARDWARE=1 HEADFUL=1 MODEL=/path/model6280000.onnx` additionally checks actual
hardware FP16 and reports retained/published-output deltas against original-model
CPU FP32 and native GPU FP32. See the script header for browser/desktop options;
the NVIDIA test uses the explicitly experimental Dawn flag described above.
`BASE_URL=https://ng-onnx-dot-seung-lab.appspot.com/ ISOLATED=1 MAX_CPU_THREADS=8`
tests the isolated production service and requires
`Math.max(1, Math.min(8, navigator.hardwareConcurrency || 1))` threads on load and
output. Pass its custom `RUNTIME_MANIFEST` to check the deployed native pair.
`BASE_URL=https://bundle-onnx-dot-seung-lab.appspot.com/ ISOLATED=1` retains the
existing four-thread expectation. `ISOLATED=0` still tests the one-thread
nonisolated fallback on matching local/remote headers. Omitting `BASE_URL` serves
local build assets with the selected headers.
Both modes require actual correct CPU numeric outputs and identical fresh-context
URL replay (including the legacy absent-precision recipe), not shape-only success.
Existing native runtime hashes remain checked. Numerical differences are reported,
not asserted to establish segmentation accuracy.

The dynamic-model production smoke exercises a one-channel model with custom
names, input ZYX `16×128×128`, raw output `48×128×128`, and retained output
`36×96×96`, using input voxel size XYZ `16×16×45 nm` and output `16×16×15 nm`:

```sh
CHROME=/usr/bin/google-chrome node tests/inference/dynamic_production.mjs
OVERLAP=0 CHROME=/usr/bin/google-chrome node tests/inference/dynamic_production.mjs
```

This script defaults to `OVERLAP=1` to exercise blending, not to reflect the UI
default: it asserts the checkbox starts unchecked and explicitly selects the test's
overlap setting. The no-overlap variant checks direct copied values across
retained-patch boundaries, fixed live display chunks, patch-cache reuse, and
restoration with overlap disabled.

Both variants run live inference, check actual worker execution, raw-input crop
values, physical placement, channel count, pan/cache demand and fresh-context
replay of the version-2 URL recipe. `MODEL=/path/model.onnx`
replaces the deterministic fixture with a real model of those shapes;
`PROVIDER=webgpu` checks strict GPU execution on a hardware-capable browser.

Model geometry support does not imply operator support in every provider. The
`model6280000.onnx` raw graph previously failed the old JSEP runtime with
`Unsupported padding parameter: 0,2,2,0,2,2`; native WebGPU 1.31.1 supports the
original graph on the tested hardware. Auto still reports provider failures and
uses CPU when necessary. No general-purpose graph conversion is performed.

InstanceNormalization makes predictions patch-dependent. Wu post-crop blending
does not guarantee whole-volume inference equivalence or eliminate seams.
Dynamic/symbolic tensor shapes, layouts other than batch-one NCDHW, multichannel
inputs, general model conversion, affine resampling, user-model uploads, durable
prediction storage, other selectable blending windows and instance segmentation
are not part of this implementation.
