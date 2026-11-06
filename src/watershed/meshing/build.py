#!/usr/bin/env python3
"""Build the pinned extractor without wasm-bindgen or Cargo dependencies."""
import ast
import hashlib
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent
SOURCE_HASH = "1a0a2756d60af44b9f0612cec881bdfc9da81065ba5ca8b9804324f1fbb06c2b"

source = (ROOT / "upstream/lib.rs").read_bytes()
if hashlib.sha256(source).hexdigest() != SOURCE_HASH:
    raise SystemExit("Pinned marching-cubes upstream source hash mismatch")
text = source.decode()
core = text[text.index("static TRI_TABLE:"):text.index("#[wasm_bindgen]\npub struct MarchingCubes")]
# Enforce the assumption used by the browser's pre-allocation surface budget.
table = ast.literal_eval(re.search(r"static TRI_TABLE:.*?= (\[.*?\]);", core, re.S).group(1))
assert len(table) == 256
for row in table:
    assert len(row) == 16 and -1 in row
    edges = row[:row.index(-1)]
    assert len(edges) % 3 == 0 and len(edges) <= 15
    assert all(0 <= edge < 12 for edge in edges)

rustc = os.environ.get("RUSTC", "rustc")
version = subprocess.check_output([rustc, "--version"], text=True).strip()
if version != "rustc 1.93.1 (01f6ddf75 2026-02-11)":
    raise SystemExit("Use the official Rust 1.93.1 toolchain; see README.md: " + version)

with tempfile.TemporaryDirectory(prefix="watershed-meshing-") as work:
    core_path = Path(work) / "core.rs"
    core_path.write_text(core)
    command = [
        rustc,
        "--edition=2021", "--crate-type=cdylib", "--target=wasm32-unknown-unknown",
        "-C", "opt-level=3", "-C", "lto=yes", "-C", "panic=abort",
        "-C", "link-arg=--max-memory=134217728",
        "-C", "link-arg=-zstack-size=1048576",
        "-C", "linker=" + os.environ.get("RUST_LINKER", shutil.which("rust-lld") or "rust-lld"),
        "--remap-path-prefix=" + str(ROOT) + "=/watershed/meshing",
        "--remap-path-prefix=" + work + "=/watershed/meshing/generated",
    ]
    if "RUST_SYSROOT" in os.environ:
        command += ["--sysroot", os.environ["RUST_SYSROOT"]]
    command += [str(ROOT / "native.rs"), "-o", str(ROOT / "marching_cubes.wasm")]
    subprocess.run(command, env={**os.environ, "MC_CORE_RS": str(core_path)}, check=True)
(ROOT / "marching_cubes.wasm").chmod(0o644)
print(hashlib.sha256((ROOT / "marching_cubes.wasm").read_bytes()).hexdigest(), "marching_cubes.wasm")
