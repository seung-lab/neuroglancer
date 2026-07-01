# Edit-session e2e fixtures (TM-331, phase 2)

Reproducible, locally-served `precomputed` volumes for the edit-session e2e /
bench suite — the same `precomputed://gs://…` URL scheme as prod, but resolved
against a **local fake GCS**, so tests need no auth, hit no network, and pay no
cold `gs://` reads.

## What's committed vs generated

- **Committed** (the reproducible source of truth):
  - `manifest.json` — the declarative data-axis matrix (one row per fixture:
    `dtype · encoding · chunk · offset · size · resolutions`).
  - `generate.py` — the TensorStore generator.
- **Generated** (gitignored — regenerate any time; identical bytes from the
  manifest):
  - `buckets/<bucket>/<fixture-id>/…` — the precomputed volumes.
  - `fixtures.json` — the resolved index (`source` URL + axis metadata per
    fixture) the harness / `buildNgState` consume.

Committing the manifest + generator (not the bytes) keeps reproducibility pinned
to a small, reviewable file instead of binary blobs.

## Workflow

```bash
# 1. Generate the fixtures (writes buckets/ + fixtures.json).
uv run testdata/editing/generate.py

# 2. Serve them over a local fake GCS (each subdir of buckets/ is a bucket).
node tests/editing/harness/fake_gcs_fixtures.mjs --port 9778
#    sanity check:
curl "http://localhost:9778/storage/v1/b/zetta-editing-test/o/img_u8_raw%2Finfo?alt=media"

# 3. Build an ngState for a scenario (pure; unit-tested):
#    tests/editing/harness/build_ng_state.ts → buildNgState(scenario, fixtures)
```

## Current matrix (`manifest.json`)

| id | kind | dtype | encoding | chunk | offset | resolutions | axis exercised |
|----|------|-------|----------|-------|--------|-------------|----------------|
| `img_u8_raw` | image | uint8 | raw | 64³₁₆ | 0 | 16 | baseline image |
| `seg_u64_cseg` | seg | uint64 | compressed_segmentation | 64²×16 | 0 | 16 | cseg encoding |
| `seg_u32_raw_offset` | seg | uint32 | raw | 64²×16 | **128,128,8** | 16 | voxel offset |
| `img_u8_jpeg` | image | uint8 | jpeg | 64²×1 | 0 | 16 | jpeg (lossy) |
| `seg_u64_multires` | seg | uint64 | compressed_segmentation | 64²×16 | 0 | **16 + 32** | multi-resolution |
| `seg_u8_bigchunk` | seg | uint8 | raw | **8192×128×1** | 0 | 16 | chunk > 4096 |

Add a fixture = add a manifest row + regenerate. Content is a deterministic
function of global voxel coords (images: gradient; segmentations: blocky 32-voxel
IDs, never 0), so reads are reproducible run-to-run.

## End-to-end correctness suite

All wired up — `npm run bench:correctness` (fixtures → build → run):

- `tests/editing/harness/gcs_route.ts` route-rewrites the app's
  `storage.googleapis.com` reads onto the local fake-gcs (COEP-safe `fulfill`).
- `tests/editing/harness/build_ng_state.ts` turns a scenario into the ngState.
- `src/editing/benchmarks/edit_paint_bench.ts` drives a deterministic stamp and
  reads back the painted voxels (`src/editing/benchmarks/patch_readback.ts`).
- `tests/editing/bench/edit_paint_correctness.spec.ts` ties it together:
  load → stamp → assert count / value / region-containment / deterministic
  signature, per scenario (incl. the offset target).

Pure pieces are unit-verified under vitest; the full run needs the prod build +
a WebGL2/COI browser (like the perf bench, it is not a normal-CI gate).
