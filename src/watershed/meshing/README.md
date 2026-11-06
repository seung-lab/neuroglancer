# Browser-only watershed meshing

`extractWatershedMesh(mask: Uint8Array, shapeXYZ: readonly number[])` returns
`Promise<{ vertexPositions: Float32Array; indices: Uint32Array }>`.
It is an extractor, not a new region/segmentation controller or worker. Call it
through Neuroglancer's existing async-computation infrastructure. The caller
supplies the mask for a selected **final agglomerated label** and owns publication
identity, region placement, cancellation, generation checks, and cache eviction.

## Contract and limits

- Positive integer XYZ dimensions, X-fastest bytes (`x + nx * (y + ny * z)`),
  at most `2**21` samples, independently of the larger watershed limit. Bytes
  must be **0/255**, not 0/1: upstream normalizes by 255, and extraction uses
  isovalue 0.5.
- Returned coordinates are XYZ voxel-model-local coordinates, including the
  upstream `+0.5` voxel-center offset on **each** axis. There is no region origin,
  physical spacing, or datasource offset applied here. The caller must place
  the regional result using the volume's coordinate convention exactly once.
- **Open partial ROI:** only cells between supplied samples are extracted.
  No zero padding, caps, or invented outside samples. Uniform masks and regions
  with any dimension below 2 return empty arrays. A foreground-filled ROI can
  therefore have no surface; that does not imply a complete object is absent.
- Classic table-based marching cubes, with outward winding from foreground 255
  toward background 0. No smoothing, simplification, vertex welding, or normals.
  Sequential indices describe triangle soup; the existing mesh backend computes
  normals. Binary singleton samples produce octahedra, not voxel-face cubes.
- **No MC33/asymptotic decider or topology guarantee.** The pinned classic table
  has ambiguous configurations (e.g. complementary cases 5/250 emit 2/4
  triangles). Do not assume complement-symmetric or guaranteed manifold output.
- Before loading WASM or allocating native buffers, count mixed cells. Each has
  an upper bound of five triangles. Reject if `mixedCells * 5 > 2**18` triangles,
  equivalently more than 12,582,912 bytes of returned positions + indices.
  This is deliberately conservative: a surface can be rejected even if its exact
  triangle count would fit. Errors are visible; output is never truncated.
- Native output allocation is at most 9,437,184 bytes, plus a mask of at most
  2,097,152 bytes. Native extraction allocates nothing, checks output capacity,
  and the module has a 64 MiB linear-memory ceiling. The returned mesh byte budget
  is **not** a total process-memory budget: copied inputs, scratch/native output,
  JavaScript output, renderer normals/GPU buffers, and concurrent worker realms
  all contribute. The caller must separately bound selection/concurrency/cache
  memory. Freed WASM memory may remain in the module's reusable heap.
- Inputs are copied before the asynchronous load. Native execution and output
  copying have no intervening awaits, so calls sharing a realm cannot interleave
  allocations/extraction. Outputs own their buffers and survive later memory
  growth/calls. The synchronous kernel is not interruptible: callers must discard
  obsolete results by generation, not assume an AbortSignal stops this function.
- No shared memory, threads, wasm-bindgen glue, COOP/COEP, or WASM MIME requirement.
  Loading failures reject visibly; a later call may retry loading.

## Provenance and audit

Source: <https://github.com/Twinklebear/webgl-marching-cubes>

Pinned commit: `4e4ac26a61ffedc37fedd69f5e441b5a5c23dd83`.
`upstream/lib.rs` is the **unmodified** upstream `src/lib.rs`. The MIT license and
Will Usher's copyright notice are preserved in `upstream/LICENSE.md`. That license
also covers the extraction adapted into `native.rs`.

The build includes the upstream table, corner/edge numbering, and interpolation
function verbatim. `native.rs` adapts the extraction loop to a small standalone
ABI with explicit caller-owned allocations; removes wasm-bindgen/js-sys, the
retained `MarchingCubes` object and growing `Vec`; fixes the isovalue to 0.5;
validates dimensions/mask bytes; and checks caller output capacity. It preserves
traversal order, interpolation, table order/winding, and the `+0.5` offset.
The discarded upstream code only supplies bindings, logging and state management;
no different extraction algorithm is substituted. There are no Cargo dependencies.

The build verifies the pinned source hash and audits all 256 rows: complete
triples of edge indices 0..11 before the first -1, at most five triangles per row.
Zeroes after the first -1 are padding, not extra triangles.

SHA-256:

| File                  | Hash                                                               |
| --------------------- | ------------------------------------------------------------------ |
| `upstream/lib.rs`     | `1a0a2756d60af44b9f0612cec881bdfc9da81065ba5ca8b9804324f1fbb06c2b` |
| `upstream/LICENSE.md` | `c23c6b31737315fbe25de3e7f1936396f49cdd93fcb55d63e311b6b7ab0bc750` |
| `native.rs`           | `accb866557f1b2be1a009923e64d848da3a141f97b67a91b037eb9395ce76649` |
| `marching_cubes.wasm` | `15cbcd44151e148f9ca73f1cc0409ca9fb66ce42ac26b19ee8c4014636011108` |

The checked-in module is 80,636 bytes, has no imports, and exports `memory`,
`mc_alloc`, `mc_free`, `mc_extract`, plus linker globals `__data_end`/`__heap_base`.

## Rebuild

Use Python 3 and the **official Rust 1.93.1** compiler/wasm standard library.
The system's Debian-source-built rustc may reject official wasm std metadata even
with the same displayed release/version. No wasm-pack or wasm-bindgen is needed.
With a matching rustup installation (installation is optional; not done here):

```sh
rustup toolchain install 1.93.1 --profile minimal --target wasm32-unknown-unknown
RUSTC="$(rustup which --toolchain 1.93.1 rustc)"
SYSROOT="$($RUSTC --print sysroot)"
HOST="$($RUSTC -vV | awk '/^host:/ {print $2}')"
export RUSTC
RUST_LINKER="$SYSROOT/lib/rustlib/$HOST/bin/rust-lld" \
  python3 src/watershed/meshing/build.py
sha256sum src/watershed/meshing/marching_cubes.wasm
```

For this build, official compiler and target archives were extracted only under
`/tmp/neuroglancer-meshing-rust`, without global installation:

```sh
RUSTC=/tmp/neuroglancer-meshing-rust/rustc-1.93.1-x86_64-unknown-linux-gnu/rustc/bin/rustc \
RUST_LINKER=/tmp/neuroglancer-meshing-rust/rustc-1.93.1-x86_64-unknown-linux-gnu/rustc/lib/rustlib/x86_64-unknown-linux-gnu/bin/rust-lld \
RUST_SYSROOT=/tmp/neuroglancer-meshing-rust/rust-std-1.93.1-wasm32-unknown-unknown/rust-std-wasm32-unknown-unknown \
  python3 src/watershed/meshing/build.py
```

Official archive URLs and verified SHA-256 values:

- `https://static.rust-lang.org/dist/rustc-1.93.1-x86_64-unknown-linux-gnu.tar.xz`:
  `b9db2636f5a101c4cdaf46a26f8a0c8e4b5767ecdb02ae9c7ccc3ead577732bc`
- `https://static.rust-lang.org/dist/rust-std-1.93.1-wasm32-unknown-unknown.tar.xz`:
  `82bcf1e75ad071548bb97f11676b332dd260807572414553a06ee5d88d20a63e`

Two successive builds produced the listed identical module hash. Compiler flags,
including source/temp path remapping and the 64 MiB maximum memory, are recorded
in `build.py`; no network access is used by that script.

## Browser verification

```sh
npm test -- --project browser src/watershed/meshing/wasm.browser_test.ts
```

On this host, the existing `/tmp/watershed-input.workspace.mts` selects real
`/opt/google/chrome/chrome` with SwiftShader/no-sandbox:

```sh
npm test -- --workspace /tmp/watershed-input.workspace.mts --project browser \
  src/watershed/meshing/wasm.browser_test.ts
```

The 11 tests exercise actual WASM geometry: singleton positions, outward winding,
area and signed volume; planes on all three axes in a non-cubic region; merged
interface removal and open boundaries; thin regions; byte/shape/voxel/surface
validation; large allocations, concurrent initialization, owned inputs/outputs,
and recovery after rejection. They do not claim renderer integration, global
object completeness, or topology correctness on ambiguous configurations.
