#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "tensorstore",
#     "numpy",
# ]
# ///
"""
Generate deterministic `neuroglancer_precomputed` fixtures for the edit-session
e2e suite (TM-331, phase 2).

Reads `manifest.json` (the declarative data-axis matrix) and writes one
precomputed volume per fixture into a per-bucket directory layout that the
`fake-gcs-server` filesystem backend serves verbatim:

    testdata/editing/buckets/<BUCKET>/<fixture-id>/{info, <scale>/...}

so the built app can load `precomputed://gs://<BUCKET>/<fixture-id>` against a
LOCAL fake GCS — byte-identical URL scheme to prod, no auth, no cold `gs://`.

Content is a deterministic function of global voxel coords (so reads are
reproducible across runs): images get a gradient, segmentations get blocky IDs.
Also emits `fixtures.json` — the resolved index (source URL + axis metadata per
fixture) that the harness / `buildNgState` consume.

Run:  uv run testdata/editing/generate.py
      (CI / the harness can invoke it before the e2e run; output is gitignored.)
"""

import json
import os
import shutil

import numpy as np
import tensorstore as ts

HERE = os.path.dirname(os.path.abspath(__file__))
BUCKET = "zetta-editing-test"
BUCKETS_ROOT = os.path.join(HERE, "buckets")

# compressed_segmentation needs a block size; 8³ divides every chunk we use.
CSEG_BLOCK = [8, 8, 8]


def downsample_factor(base, res):
    """Integer per-axis factor mapping the base resolution to `res`."""
    return [max(1, round(r / b)) for r, b in zip(res, base)]


def scale_size(size, factor):
    return [-(-s // f) for s, f in zip(size, factor)]  # ceil-div


def content(kind: str, dtype: str, origin, shape):
    """Deterministic voxel content as a numpy array of `shape` + channel axis."""
    ox, oy, oz = origin
    sx, sy, sz = shape
    xx, yy, zz = np.meshgrid(
        np.arange(ox, ox + sx),
        np.arange(oy, oy + sy),
        np.arange(oz, oz + sz),
        indexing="ij",
    )
    if kind == "image":
        val = ((xx * 2 + yy) % 256).astype(dtype)
    else:
        # Blocky 32-voxel segment IDs, never 0 (0 reads as "empty" in the app).
        val = (((xx // 32) + (yy // 32) + zz) % 7 + 1).astype(dtype)
    return val[..., np.newaxis]  # trailing channel axis


def scale_metadata(fixture, res, factor):
    meta = {
        "encoding": fixture["encoding"],
        "chunk_size": fixture["chunk"],
        "resolution": res,
        "voxel_offset": [o // f for o, f in zip(fixture["offset"], factor)],
        "size": scale_size(fixture["size"], factor),
    }
    if fixture["encoding"] == "compressed_segmentation":
        meta["compressed_segmentation_block_size"] = CSEG_BLOCK
    return meta


def write_fixture(fixture):
    path = os.path.join(BUCKETS_ROOT, BUCKET, fixture["id"])
    shutil.rmtree(path, ignore_errors=True)
    base = fixture["resolutions"][0]
    for res in fixture["resolutions"]:
        factor = downsample_factor(base, res)
        meta = scale_metadata(fixture, res, factor)
        store = ts.open(
            {
                "driver": "neuroglancer_precomputed",
                "kvstore": {"driver": "file", "path": path},
                "scale_metadata": meta,
                "multiscale_metadata": {
                    "data_type": fixture["dtype"],
                    "num_channels": 1,
                    "type": fixture["kind"],
                },
            },
            create=True,
            open=True,
            dtype=getattr(ts, fixture["dtype"]),
        ).result()
        origin = [o for o in meta["voxel_offset"]]
        store[...] = content(fixture["kind"], fixture["dtype"], origin, meta["size"])
    return {
        "id": fixture["id"],
        "kind": fixture["kind"],
        "dtype": fixture["dtype"],
        "encoding": fixture["encoding"],
        "chunk": fixture["chunk"],
        "offset": fixture["offset"],
        "size": fixture["size"],
        "resolutions": fixture["resolutions"],
        "source": f"precomputed://gs://{BUCKET}/{fixture['id']}",
    }


def main():
    with open(os.path.join(HERE, "manifest.json")) as f:
        manifest = json.load(f)
    resolved = [write_fixture(fx) for fx in manifest]
    index = {"bucket": BUCKET, "fixtures": resolved}
    with open(os.path.join(HERE, "fixtures.json"), "w") as f:
        json.dump(index, f, indent=2)
        f.write("\n")
    print(f"Wrote {len(resolved)} fixtures to {os.path.join(BUCKETS_ROOT, BUCKET)}")
    for fx in resolved:
        print(f"  {fx['id']:<20} {fx['encoding']:<24} {fx['source']}")


if __name__ == "__main__":
    main()
