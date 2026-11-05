# Abiss watershed WebAssembly

This directory vendors the GPL-3.0-or-later Abiss watershed and optional
post-watershed agglomeration algorithms, not an Apache-licensed Neuroglancer
decoder. The standalone, single-threaded module uses native WebAssembly
exceptions and requires a browser that supports them. It needs no JavaScript
runtime glue, SharedArrayBuffer, or COOP/COEP headers.

- Abiss source commit: `8893da763a1630c6f2c25d6059fef26c13d72889` on branch
  `watershed-wasm-agglomeration`.
- Build SDK: Emscripten **3.1.69-git** (`c55ff404`), Clang **20.0.0git**
  (`50866e84`), and bundled Boost **1.90.0** headers. This is not the 4.0.15 SDK
  used by the previous watershed-only binary.
- Binary: **87,429 bytes**, SHA-256
  `fb8c6031c5d5fb5b826e32522a7c391364079c9f628ef53cc79b5b91d6174bba`.
- Source archive SHA-256:
  `5e77afedc5679644709d0e4cfc318c34f4041cc12e6e6722c4e29b3d8f5b5f05`.

`abiss-watershed-source.tar.gz` contains the corresponding complete Abiss source,
required Boost headers, licenses, build script, checksums, analytic fixtures,
and verification evidence. `BUILDING.md` supplies the immutable SDK URL and
checksum, ABI, and pinned clean-build recipe. The bundled-header clean rebuild
was byte-identical. `VERIFICATION.md` records executed checks and the enabled
tie-order limitation below, including the original failing stress report.
The viewer links both the source archive and `LICENSE` in the WASM Watershed
dialog, and bundlers emit them alongside the WASM asset.

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

The only import is `env.emscripten_notify_memory_growth`. Counts are elements.
Caller owns input/output allocations. Output is written only on success.
Statuses: 0 success, 1 invalid input, 2 allocation failure, 3 internal error.
Refresh memory views after allocations/calls; copy output before freeing.

Omitting `WatershedOptions.aggThreshold` calls the unchanged watershed export.
A present finite threshold in `[0,1]`, **including zero**, calls the agglomerating
export. SIZE/DUST cleanup runs first; there is no second dust pass. Adjacent
nonzero basins merge when their shared-boundary mean affinity is **strictly
greater than** the threshold. Subsequent scores use accumulated affinity sums
and contact areas, including weak/zero contacts. Background never merges.
Final labels follow full remap chains but are **not recompacted**.

Equal-score merges retain the native kernel's heap/unordered-map behavior;
there is no cross-platform canonical tie order. An additional 128-case enabled
native/WASM exact-ID stress run had **127 passes and one ID mismatch**. In that
checked case the partition/background were identical, but WASM retained ID 3
and native retained ID 6. Diagnostic traces confirmed equal-score merge-order
divergence, not a threshold-rounding failure. This does not establish general
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
