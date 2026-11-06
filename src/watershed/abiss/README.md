# Abiss watershed WebAssembly

This directory vendors the GPL-3.0-or-later Abiss watershed and optional
post-watershed agglomeration algorithms, not an Apache-licensed Neuroglancer
decoder. The standalone, single-threaded module uses native WebAssembly
exceptions and requires a browser that supports them. It needs no JavaScript
runtime glue, SharedArrayBuffer, or COOP/COEP headers.

- Abiss base commit: `8893da763a1630c6f2c25d6059fef26c13d72889` on branch
  `watershed-wasm-agglomeration`, plus one **local build-configuration patch**:
  `CMakeLists.txt:32` changes `MAXIMUM_MEMORY=2147483648` to
  `MAXIMUM_MEMORY=4294967296`. This is not an unmodified upstream-source build;
  no algorithm or C ABI changed.
- Build SDK: Emscripten **3.1.69-git** (`c55ff404`), Clang **20.0.0git**
  (`50866e84`), and bundled Boost **1.90.0** headers. This is not the 4.0.15 SDK
  used by the previous watershed-only binary.
- Binary: **87,429 bytes**, SHA-256
  `7d7dcf0e989f2f0cdcab6acf17bf23b655254cc6b4faff9cfc9f1975d773e825`.
- Source archive: **809,148 bytes**, SHA-256
  `5e6045ffc2c1a4531ad61157c1da06196814fa5a94d4929fa91f865602d33918`.
- Unshared wasm32 memory: **16 MiB initially**, growing on demand up to
  **4 GiB (65,536 pages)**. This raises the ceiling; it does not preallocate
  4 GiB or guarantee every large job will fit. The previous maximum was 2 GiB.
  The rebuilt binary differs at only one byte, in the memory declaration.

`abiss-watershed-source.tar.gz` contains the complete 113-file Abiss source tree
with the exact patched CMake file, matching new binary, 682 Boost headers and
licenses, build script, checksums, analytic fixtures, and verification evidence.
The local patch is recorded separately and already applied. `BUILDING.md`
supplies the immutable SDK URL/checksum, ABI, and pinned clean-build recipe.
Independent clean-source and freshly extracted archive rebuilds were
byte-identical; all **851 current manifest entries** passed checksum audit.
`VERIFICATION.md` separates newly executed 4 GiB checks from unchanged historical
reports, including the known enabled tie-order failure. Old baseline binaries
are not bundled. The viewer links both the source archive and `LICENSE` in the
WASM Watershed dialog, and bundlers emit them alongside the WASM asset.

To rebuild, from this directory:

```sh
source_dir="$(mktemp -d)"
tar -xzf abiss-watershed-source.tar.gz -C "$source_dir"
cd "$source_dir"
sha256sum -c SHA256SUMS
# Follow BUILDING.md to obtain the pinned SDK outside this source tree.
# Set EM_CONFIG=/dev/null and put its install/emscripten and install/bin on PATH.
./build.sh "${source_dir}-build" # env-only CTest, then exact binary comparison
node verify_memory_4gib.cjs     # limits and complete ABI; no large allocation
```

The new native core CTest suite passes 5/5; WASM CTest passes 1/1; all 31 analytic
fixtures and 128 seeded disabled previous/new/native comparisons pass. Full-size
64Mi-voxel Chrome jobs are separate parent/application tests, not part of this
native-build proof.

The input is planar `Float32 [3,Z,Y,X]`, X fastest, with channels connecting
the current voxel toward **−X, −Y, −Z**. The output is `Uint32 [Z,Y,X]`,
0 background and positive region-local labels. Outside-facing edges are
ignored; each invocation is a complete bounded region, **not stitched tiles**.

Exports (no leading underscores except initialization):

```text
memory
_initialize()                         // exactly once
malloc(byte_count) -> pointer
free(pointer)
abiss_watershed(affinity_ptr, affinity_count, x, y, z,
                high_f32, low_f32, size_u32, dust_u32,
                labels_ptr, label_count) -> status_i32
abiss_watershed_agglomerate(affinity_ptr, affinity_count, x, y, z,
                high_f32, low_f32, size_u32, dust_u32, agg_threshold_f32,
                labels_ptr, label_count) -> status_i32
abiss_watershed_last_error() -> NUL-terminated UTF-8 pointer
```

The only import is `env.emscripten_notify_memory_growth(i32) -> void`; a no-op
callback may ignore its memory-index argument. Toolchain helper exports
`__indirect_function_table` and `__trap` are also unchanged. Counts are elements.
Caller owns input/output allocations. Output is written only on success.
Statuses: 0 success, 1 invalid input, 2 allocation failure, 3 internal error.
Normalize returned i32 pointers with `>>> 0` before using them as JavaScript
addresses, particularly above 2 GiB. Refresh memory views after allocations/calls;
copy output before freeing.

Omitting `WatershedOptions.aggThreshold` calls the unchanged watershed export.
A present finite threshold in `[0,1]`, **including zero**, calls the agglomerating
export. SIZE/DUST cleanup runs first; there is no second dust pass. Adjacent
nonzero basins merge when their shared-boundary mean affinity is **strictly
greater than** the threshold. Subsequent scores use accumulated affinity sums
and contact areas, including weak/zero contacts. Background never merges.
Final labels follow full remap chains but are **not recompacted**.

Equal-score merges retain the native kernel's heap/unordered-map behavior;
there is no cross-platform canonical tie order. An additional 128-case enabled
native/WASM exact-ID stress run had **127 passes and one ID mismatch**, reproduced
by the new 4 GiB build's full verifier (which exits 1, not PASS). Historical
analysis of that case found identical partition/background but WASM retained
ID 3 and native retained ID 6; historical diagnostic traces confirmed equal-score
merge-order divergence, not threshold rounding. Those trace/partition experiments
were not rerun for this build-flag-only change. This does not establish general
native/WASM partition equivalence for tied inputs. No output renumbering or
algorithm change was introduced to hide the mismatch.

`../testdata/native-reference.json` retains the 80 original watershed-only
fixtures from Abiss commit `6153122`. Browser tests still compare exact labels
for all of them. `../testdata/agglomeration-native-reference.json` adds 31
analytic native fixtures from the new source commit, including disabled
compatibility, strict/zero thresholds, size/dust cleanup, and dynamic weighted
mean updates. Browser tests compare their exact labels and also exercise
independent mean-linkage, masking, memory-growth, and concurrent-option cases.
The bundled verification separately passes 128 seeded old/new/native exact
**disabled** comparisons; enabled exact-ID parity is not claimed universally.
