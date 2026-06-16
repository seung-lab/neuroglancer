# Vendored pyodide packages (TM-322)

The painting morphology worker (`src/editing/tool_runtimes/morphology_handler.ts`)
runs pyodide with numpy + scipy. To enable cross-origin isolation
(`Cross-Origin-Embedder-Policy: require-corp`, required for `SharedArrayBuffer`),
**all** pyodide assets must be served same-origin — they can no longer stream
from the jsDelivr CDN.

The pyodide **core** runtime (`pyodide.mjs`, `pyodide.asm.{js,wasm}`,
`python_stdlib.zip`, `pyodide-lock.json`) ships in the `pyodide` npm package and
is copied into the build by `CopyRspackPlugin` (see `rspack.config.js`).

The **science package wheels** are NOT in the npm package, so they are vendored
here and copied alongside the core. They are the exact dependency closure of
`numpy` + `scipy` resolved from `node_modules/pyodide/pyodide-lock.json` at
pyodide **v0.26.2**:

| File                                                 | Package  | Version |
| ---------------------------------------------------- | -------- | ------- |
| `numpy-1.26.4-cp312-cp312-pyodide_2024_0_wasm32.whl` | numpy    | 1.26.4  |
| `scipy-1.12.0-cp312-cp312-pyodide_2024_0_wasm32.whl` | scipy    | 1.12.0  |
| `openblas-0.3.26.zip`                                | openblas | 0.3.26  |

Source: `https://cdn.jsdelivr.net/pyodide/v0.26.2/full/<file>`.

## Updating

These are version-locked to the pinned `pyodide` (`package.json`: `"pyodide": "0.26.2"`).
When bumping pyodide, recompute the closure and re-vendor:

```sh
node -e 'const l=require("./node_modules/pyodide/pyodide-lock.json");const seen=new Set(),st=["numpy","scipy"];while(st.length){const n=st.pop().toLowerCase();if(seen.has(n))continue;const e=l.packages[n];if(!e){console.error("missing",n);continue}seen.add(n);for(const d of e.depends||[])st.push(d)}for(const k of seen)console.log(l.packages[k].file_name)'
# then download each file from https://cdn.jsdelivr.net/pyodide/v<version>/full/<file>
```
