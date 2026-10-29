#!/usr/bin/env python3
"""Emit an exact verified padding-only byte-splice recipe (no graph changes).

Usage: python build_tools/generate_model6280000_jsep_recipe.py ORIGINAL PREPARED
Add --model nooverseg for prepare_nooverseg_jsep.py's padding-only output.
The input pair is immutable and SHA-256 pinned. The model6280000 prepared
artifact is the separately verified padding-only oracle output, not a new
optimizer. Only protobuf record boundaries are diffed; weights are never
embedded. Tool dependencies: standard library only. Pipe through Prettier.
"""

import argparse
import base64
import difflib
import hashlib
from dataclasses import dataclass
from pathlib import Path

ORIGINAL_SHA256 = "2c19eac209030e9f1d3b52d6dfaa72a509291f8644ca0e36fbe22231f2baac3c"
PREPARED_SHA256 = "88604328d32e603a4d6de3d3625127e77311448fd9ad0bb45201cfdc85fd9828"
ORIGINAL_BYTES = 47337104
PREPARED_BYTES = 47337252

PROFILES = {
    "model6280000": (
        ORIGINAL_SHA256, PREPARED_SHA256, ORIGINAL_BYTES, PREPARED_BYTES
    ),
    "nooverseg": (
        "0493be1d38f98236a4782404e616569b5838020a5a892de429d30a5372285860",
        "529a6005da64066269ec29ac60151eaa4abcbf80a44e226e7068923d7c9a45df",
        42520250,
        42520386,
    ),
}


@dataclass
class Field:
    number: int
    wire: int
    start: int
    payload: int
    end: int


def varint(data, offset):
    value = shift = 0
    while True:
        byte = data[offset]
        offset += 1
        value |= (byte & 127) << shift
        if not byte & 128:
            return value, offset
        shift += 7
        assert shift < 70


def fields(data, start, end):
    result = []
    while start < end:
        tag, offset = varint(data, start)
        wire = tag & 7
        if wire == 2:
            length, payload = varint(data, offset)
            finish = payload + length
        elif wire == 0:
            payload = offset
            _, finish = varint(data, offset)
        else:
            assert wire in (1, 5)
            payload = offset
            finish = offset + (8 if wire == 1 else 4)
        assert finish <= end
        result.append(Field(tag >> 3, wire, start, payload, finish))
        start = finish
    assert start == end
    return result


def key(data, field, kind):
    # Stable record identity allows small attribute edits rather than embedding
    # whole changed nodes. All original nodes and initializers are preserved.
    name_field = {
        "graph": {1: 3, 5: 8, 11: 1, 12: 1, 13: 1},
        "node": {5: 1},
    }.get(kind, {}).get(field.number)
    if name_field is not None:
        names = [
            data[f.payload : f.end]
            for f in fields(data, field.payload, field.end)
            if f.number == name_field
        ]
        assert len(names) == 1
        return field.number, names[0]
    if kind == "model" and field.number == 7:
        return (7,)
    return field.number, data[field.start : field.end]


def replacements(original, prepared):
    edits = []

    def emit(start, end, value):
        if original[start:end] != value:
            if edits and edits[-1][1] == start:
                prev_start, _, prev_value = edits.pop()
                edits.append((prev_start, end, prev_value + value))
            else:
                edits.append((start, end, value))

    def diff(a_start, a_end, b_start, b_end, kind):
        a = fields(original, a_start, a_end)
        b = fields(prepared, b_start, b_end)
        matcher = difflib.SequenceMatcher(
            a=[key(original, f, kind) for f in a],
            b=[key(prepared, f, kind) for f in b],
            autojunk=False,
        )
        for op, a0, a1, b0, b1 in matcher.get_opcodes():
            if op != "equal":
                start = a[a0].start if a0 < len(a) else a_end
                end = a[a1].start if a1 < len(a) else a_end
                new_start = b[b0].start if b0 < len(b) else b_end
                new_end = b[b1].start if b1 < len(b) else b_end
                emit(start, end, prepared[new_start:new_end])
                continue
            for x, y in zip(a[a0:a1], b[b0:b1]):
                if original[x.start : x.end] == prepared[y.start : y.end]:
                    continue
                child = {("model", 7): "graph", ("graph", 1): "node"}.get(
                    (kind, x.number)
                )
                if child is None:
                    emit(x.start, x.end, prepared[y.start : y.end])
                else:
                    emit(x.start, x.payload, prepared[y.start : y.payload])
                    diff(x.payload, x.end, y.payload, y.end, child)

    diff(0, len(original), 0, len(prepared), "model")
    output = bytearray()
    offset = 0
    for start, end, value in edits:
        assert offset <= start <= end <= len(original)
        output.extend(original[offset:start])
        output.extend(value)
        offset = end
    output.extend(original[offset:])
    assert output == prepared, "recipe must exactly reproduce verified artifact"
    # Conv attributes only, never weights, new nodes or inferred metadata.
    assert sum(len(value) for _, _, value in edits) < 20000
    return edits


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("original", type=Path)
    parser.add_argument("rewritten", type=Path)
    parser.add_argument("--model", choices=PROFILES, default="model6280000")
    args = parser.parse_args()
    original_sha256, prepared_sha256, original_bytes, prepared_bytes = PROFILES[args.model]
    original, prepared = args.original.read_bytes(), args.rewritten.read_bytes()
    for data, size, fingerprint in (
        (original, original_bytes, original_sha256),
        (prepared, prepared_bytes, prepared_sha256),
    ):
        if len(data) != size or hashlib.sha256(data).hexdigest() != fingerprint:
            parser.error(
                "input is not the exact verified artifact; refusing recipe generation"
            )
    license_header = (
        Path(__file__).resolve().parent.parent / "src/inference/prepare.ts"
    ).read_text().split("*/", 1)[0] + "*/\n"
    print(license_header)
    print("// Generated by build_tools/generate_model6280000_jsep_recipe.py.")
    print(f"// {args.model}: Conv padding only; nodes and weights are preserved.")
    for name, value in (
        ("ORIGINAL_SHA256", f'"{original_sha256}"'),
        ("PREPARED_SHA256", f'"{prepared_sha256}"'),
        ("ORIGINAL_BYTES", original_bytes),
        ("PREPARED_BYTES", prepared_bytes),
    ):
        print(f"export const {name} = {value};")
    print(
        "export const REPLACEMENTS: readonly (readonly [number, number, string])[] = ["
    )
    for start, end, value in replacements(original, prepared):
        encoded = base64.b64encode(value).decode("ascii")
        chunks = [encoded[i : i + 96] for i in range(0, len(encoded), 96)] or [""]
        text = " +\n".join(f'"{chunk}"' for chunk in chunks)
        print(f"[{start}, {end}, {text}],")
    print("];")


if __name__ == "__main__":
    main()
