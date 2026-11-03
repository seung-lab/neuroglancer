# Abiss watershed WebAssembly

This directory vendors the GPL-3.0-or-later Abiss watershed algorithm, not an
Apache-licensed Neuroglancer decoder. The standalone, single-threaded module
uses native WebAssembly exceptions and requires a browser that supports them.
It needs no JavaScript runtime glue, SharedArrayBuffer, or COOP/COEP headers.

- Abiss source commit: `6153122` on branch `watershed-wasm`.
- Build SDK: Emscripten **4.0.15**.
- Binary SHA-256:
  `39ee6d816fe53b4396ed5ba73ff36e719117a087a68d5eeaddbb6bb08d772c2b`.
- Source archive SHA-256:
  `56b80700bbd974804d4eb50c9d6ae85ba78c0ecaed4aa9a89db6b27001c0ee14`.

`abiss-watershed-source.tar.gz` contains the corresponding Abiss source, all
required Boost headers, licenses, build script, checksums, and a `BUILDING.md`
document with the ABI and pinned clean-build recipe. The clean rebuild was
byte-identical. The viewer links both the source archive and `LICENSE` in the
WASM Watershed dialog, and bundlers emit them alongside the WASM asset.

The input is planar `Float32 [3,Z,Y,X]`, X fastest, with channels connecting
the current voxel toward **−X, −Y, −Z**. The output is `Uint32 [Z,Y,X]`,
0 background and compact positive ROI-local labels. Outside-facing edges are
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
abiss_watershed_last_error() -> NUL-terminated UTF-8 pointer
```

The only import is `env.emscripten_notify_memory_growth`. Counts are elements.
Caller owns input/output allocations. Output is written only on success.
Statuses: 0 success, 1 invalid input, 2 allocation failure, 3 internal error.
Refresh memory views after allocations/calls; copy output before freeing.

Native-reference fixtures in `../testdata/native-reference.json` were generated
by the Abiss agent from the native C++ implementation at the same commit.
They cover negative-axis direction, singleton dimensions, outside-facing edges,
plateaus, threshold equality, region-size merging, dust removal, and seeded
random inputs. Browser tests compare **exact labels**, not just their count.
