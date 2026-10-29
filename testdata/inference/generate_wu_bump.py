#!/usr/bin/env python3
"""Generate Wu goldens by executing Chunkflow's actual patch_mask.py.

Requires only NumPy; does not import the chunkflow package. Example:
  /tmp/neuroglancer-onnx-venv/bin/python testdata/inference/generate_wu_bump.py
  python generate_wu_bump.py --chunkflow-root /path/to/chunkflow

Only writes wu_bump.json beside this script (or --output). All indices, shapes,
strides, and origins are ZYX. Small-case samples cover every voxel in C order.
"""

import argparse
import hashlib
import importlib.util
import itertools
import json
from pathlib import Path
import subprocess

import numpy as np

SOURCE = "chunkflow/chunk/image/convnet/patch/patch_mask.py"


def git(root, *args):
    try:
        return subprocess.check_output(
            ["git", "-C", str(root), *args], stderr=subprocess.DEVNULL, text=True
        ).strip()
    except (OSError, subprocess.CalledProcessError):
        return None


def main_samples(shape):
    # Corners, face/edge centers, overlap transitions, overlap interior, and
    # center; explicitly include the reflection of every selected point.
    seeds = list(itertools.product((0, 15), (0, 59), (0, 59)))
    seeds += [(0, 29, 29), (7, 0, 29), (7, 29, 0)]
    seeds += [(0, 0, 29), (0, 29, 0), (7, 0, 0),
              (0, 59, 29), (0, 29, 59), (7, 0, 59)]
    seeds += [(z, 29, 29) for z in (5, 6)]
    seeds += [(7, y, 29) for y in (19, 20)]
    seeds += [(7, 29, x) for x in (19, 20)]
    seeds += [(2, 9, 9), (5, 19, 19), (7, 29, 29), (7, 30, 29)]
    points = set(seeds)
    points.update(tuple(n - 1 - i for n, i in zip(shape, p)) for p in seeds)
    return sorted(points)


def make_case(module, case_id, shape, stride, full=False):
    overlap = tuple(n - s for n, s in zip(shape, stride))
    bump = module.make_bump_map(shape)
    mask = module.make_patch_mask(shape, overlap, dtype="float32")
    assert bump.dtype == np.float64 and mask.dtype == np.float32
    points = list(np.ndindex(shape)) if full else main_samples(shape)
    case = {
        "id": case_id,
        "shapeZYX": list(shape),
        "strideZYX": list(stride),
        "overlapZYX": list(overlap),
        "bumpDtype": "float64",
        "weightDtype": "float32",
        "sampleCoverage": "full-c-order" if full else "selected-reflection-pairs",
        "samples": [
            {"indexZYX": list(p), "bump": float(bump[p]), "weight": float(mask[p])}
            for p in points
        ],
    }
    return case, bump, mask


def blend(case_id, name, bump, mask, voxel, origins):
    """Independent finite-contributor blend of the source-generated mask.

    output uses binary64 accumulation of exact float32 mask values, matching a
    JS-number reference. float32Output reproduces float32 product, sequential
    accumulation, and multiplication by the float32 reciprocal used by
    Chunkflow's output_chunk_mask path. Contributor order is significant there.
    """
    contributors = []
    weighted_sum = weight_sum = raw_sum = raw_weighted_sum = 0.0
    sum32 = np.float32(0)
    weights32 = np.float32(0)
    constant32 = np.float32(0)
    constant = 7.0
    for ordinal, origin in enumerate(origins):
        index = tuple(v - o for v, o in zip(voxel, origin))
        assert all(0 <= i < n for i, n in zip(index, mask.shape))
        prediction = float(1 + 3 * ordinal + ordinal * ordinal)
        b, w = float(bump[index]), float(mask[index])
        contributors.append({
            "originZYX": list(origin), "indexZYX": list(index),
            "prediction": prediction, "bump": b, "weight": w,
        })
        weighted_sum += prediction * w
        weight_sum += w
        raw_sum += b
        raw_weighted_sum += prediction * b
        sum32 = np.float32(sum32 + np.float32(np.float32(prediction) * np.float32(w)))
        weights32 = np.float32(weights32 + np.float32(w))
        constant32 = np.float32(constant32 + np.float32(np.float32(constant) * np.float32(w)))
    reciprocal32 = np.float32(np.float32(1) / weights32)
    return {
        "id": name, "caseId": case_id, "voxelZYX": list(voxel),
        "contributors": contributors, "weightedSum": weighted_sum,
        "weightSum": weight_sum, "output": weighted_sum / weight_sum,
        "constantValue": constant, "constantOutput": constant * weight_sum / weight_sum,
        "rawBumpNormalizedOutput": raw_weighted_sum / raw_sum,
        "float32Output": float(np.float32(sum32 * reciprocal32)),
        "float32ConstantOutput": float(np.float32(constant32 * reciprocal32)),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--chunkflow-root", type=Path,
                        default=Path(__file__).resolve().parents[3] / "chunkflow")
    parser.add_argument("--output", type=Path,
                        default=Path(__file__).with_name("wu_bump.json"))
    args = parser.parse_args()
    source = args.chunkflow_root / SOURCE
    spec = importlib.util.spec_from_file_location("chunkflow_reference_patch_mask", source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    large, bump, mask = make_case(module, "postcrop-16-60-60", (16, 60, 60), (10, 40, 40))
    small, _, _ = make_case(module, "asymmetric-4-6-8", (4, 6, 8), (3, 4, 5), full=True)
    blends = [
        blend(large["id"], "finite-corner-single-contributor", bump, mask,
              (0, 0, 0), [(0, 0, 0)]),
        blend(large["id"], "aligned-z-overlap", bump, mask,
              (12, 29, 29), [(0, 0, 0), (10, 0, 0)]),
        blend(large["id"], "aligned-eight-way-overlap", bump, mask,
              (12, 48, 48), list(itertools.product((0, 10), (0, 40), (0, 40)))),
        blend(large["id"], "finite-y-boundary-four-contributors", bump, mask,
              (12, 0, 48), list(itertools.product((0, 10), (0,), (0, 40)))),
        blend(large["id"], "shifted-z-tail", bump, mask,
              (10, 29, 29), [(0, 0, 0), (8, 0, 0)]),
        blend(large["id"], "shifted-zy-tail-four-contributors", bump, mask,
              (10, 40, 29), list(itertools.product((0, 8), (0, 35), (0,)))),
    ]
    fixture = {
        "schemaVersion": 1,
        "provenance": {
            "project": "chunkflow", "gitCommit": git(args.chunkflow_root, "rev-parse", "HEAD"),
            "sourceRelativePath": SOURCE,
            "sourceSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
            "sourceGitStatus": git(args.chunkflow_root, "status", "--porcelain", "--", SOURCE),
            "numpyVersion": np.__version__,
            "generator": "testdata/inference/generate_wu_bump.py",
            "execution": "importlib.util.spec_from_file_location; actual make_bump_map and make_patch_mask",
        },
        "conventions": {
            "axisOrder": "ZYX", "sampleOrder": "lexicographic ZYX (X fastest)",
            "bump": "float64 make_bump_map; global 3D np.interp from [min,max] to [1,1e6]",
            "weight": "float32 make_patch_mask; bump divided by center of 3x3x3 stride-shifted bump sum",
            "blend": "sum(prediction * weight) / sum(weight) over actual contributors; binary64 accumulation",
            "float32Blend": "float32 products and sequential sums, multiplied by float32 reciprocal of weight sum",
            "constantFieldBoundaryPolicy": "Divide by actual positive accumulated mask, not 1 or contributor count; no epsilon clamp",
            "rawVsMask": "Raw and phase-normalized blending agree on a common stride lattice before float32 rounding, but not generally for shifted tail origins",
        },
        "cases": [large, small], "blends": blends,
    }
    args.output.write_text(json.dumps(fixture, indent=2, allow_nan=False) + "\n")
    print(f"Wrote {args.output}: {len(large['samples'])} main samples, "
          f"{len(small['samples'])} full asymmetric samples, {len(blends)} blends")


if __name__ == "__main__":
    main()
