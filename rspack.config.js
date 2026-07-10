import path from "node:path";
import process from "node:process";
import {
  CopyRspackPlugin,
  HtmlRspackPlugin,
  ProgressPlugin,
} from "@rspack/core";
import { normalizeConfigurationWithDefine } from "./build_tools/rspack/configuration_with_define.js";
import packageJson from "./package.json";

// Load `.env` (if present) so the NEUROGLANCER_ZETTA_* defines below can be set
// per-developer without editing this file or committing secrets. Node >=20.12
// provides `process.loadEnvFile` natively, so no dotenv dependency is needed.
try {
  process.loadEnvFile(path.resolve(import.meta.dirname, ".env"));
} catch {
  // No `.env` present — fall back to the real process environment (or nothing).
}

// Emit a DefinePlugin entry only when its env var is actually set, so an unset
// var stays an undeclared global and the source-side `typeof … === "undefined"`
// guards keep working. Value is JSON-stringified as DefinePlugin requires.
function zettaDefine(name) {
  const value = process.env[name];
  return value ? { [name]: JSON.stringify(value) } : {};
}

// Pyodide is self-hosted (TM-322): cross-origin isolation
// (`Cross-Origin-Embedder-Policy: require-corp`, needed for SharedArrayBuffer)
// forbids streaming pyodide from the jsDelivr CDN, so all pyodide assets must be
// served same-origin. The core runtime comes from the `pyodide` npm package; the
// numpy/scipy/openblas wheels (not in that package) are vendored under
// `pyodide_packages/`. Both are emitted to `dist/client/pyodide/` below and
// loaded same-origin by `morphology_handler.ts`.
const PYODIDE_CORE_FILES = [
  "pyodide.mjs",
  "pyodide.asm.js",
  "pyodide.asm.wasm",
  "python_stdlib.zip",
  "pyodide-lock.json",
];

export default (env, args) => {
  const mode = args.mode === "production" ? "production" : "development";
  const config = {
    mode,
    context: import.meta.dirname,
    entry: {
      main: "./src/main.bundle.js",
    },
    performance: {
      // Avoid unhelpful warnings due to large bundles.
      maxAssetSize: 3 * 1024 * 1024,
      maxEntrypointSize: 3 * 1024 * 1024,
    },
    optimization: {
      splitChunks: {
        chunks: "all",
      },
    },
    devtool: "source-map",
    module: {
      rules: [
        // Needed to support Neuroglancer TypeScript sources.
        {
          test: /\.tsx?$/,
          loader: "builtin:swc-loader",
          options: {
            jsc: {
              parser: {
                syntax: "typescript",
                decorators: true,
                tsx: true,
              },
              transform: {
                react: {
                  runtime: "automatic",
                  importSource: "preact",
                },
              },
            },
            env: {
              targets: packageJson.browserslist,
            },
          },
          type: "javascript/auto",
        },
        {
          test: /\.wasm$/,
          generator: {
            filename: "[name].[contenthash][ext]",
          },
        },
        // Needed for .svg?raw imports used for embedding icons.
        {
          resourceQuery: /raw/,
          type: "asset/source",
        },
        // Needed for .html assets used for auth redirect pages for the
        // brainmaps and bossDB data sources.
        {
          test: /(bossauth|google_oauth2_redirect)\.html$/,
          type: "asset/resource",
          generator: {
            // Filename must be preserved since exact redirect URLs must be allowlisted.
            filename: "[name][ext]",
          },
        },
      ],
    },
    devServer: {
      port: 3008,
      // Cross-origin isolation headers (COOP/COEP require-corp) for
      // SharedArrayBuffer are set by the dev `serve` command in
      // `build_tools/cli.ts` and by `vercel.json` in production (TM-324) — the
      // single source of truth — so they are intentionally not duplicated here.
      // The portal proxies this dev server under its own origin (see
      // `rewrites()` in the portal's next.config.js) so the iframe stays
      // same-origin and the portal can keep injecting its interceptor/save
      // scripts into the iframe document. Proxied requests arrive with the
      // portal's Host header, so accept any host.
      allowedHosts: "all",
      client: {
        // The iframe document is served from the portal origin, so the
        // live-reload client would otherwise try to open its websocket there
        // (where /ws is not proxied). Point it straight at this dev server.
        webSocketURL: "ws://localhost:3008/ws",
        overlay: {
          // Prevent intrusive notification spam.
          runtimeErrors: false,
        },
      },
      // Full reload (not HMR) on change — the portal re-injects its scripts
      // when the iframe document reloads.
      hot: false,
    },
    plugins: [
      new ProgressPlugin(),
      new HtmlRspackPlugin({
        title: "neuroglancer",
      }),
      // Self-host pyodide (TM-322): emit the core runtime (from the npm package)
      // and the vendored numpy/scipy/openblas wheels to `dist/client/pyodide/`,
      // which `morphology_handler.ts` loads same-origin.
      new CopyRspackPlugin({
        patterns: [
          ...PYODIDE_CORE_FILES.map((file) => ({
            from: path.resolve(
              import.meta.dirname,
              "node_modules",
              "pyodide",
              file,
            ),
            to: "pyodide/[name][ext]",
          })),
          {
            from: path.resolve(import.meta.dirname, "pyodide_packages"),
            to: "pyodide",
            globOptions: { ignore: ["**/README.md"] },
          },
        ],
      }),
    ],
    output: {
      path: path.resolve(import.meta.dirname, "dist", "client"),
      filename: "[name].[chunkhash].js",
      chunkFilename: "[name].[contenthash].js",
      asyncChunks: true,
      clean: true,
    },
    target: ["web", "browserslist"],
    experiments: {
      css: true,
    },
    // Additional defines, to be added via `DefinePlugin`.  This is not a
    // standard webpack configuration property, but is handled specially by
    // `normalizeConfigurationWithDefine`.
    define: {
      // This is the default client ID used for the hosted neuroglancer.
      // In addition to the hosted neuroglancer origin, it is valid for
      // the origins:
      //
      //   localhost:8000
      //   127.0.0.1:8000
      //   localhost:8080
      //   127.0.0.1:8080
      //
      // To deploy to a different origin, you will need to generate your
      // own client ID from on the Google Developer Console and substitute
      // it in.
      NEUROGLANCER_BRAINMAPS_CLIENT_ID: JSON.stringify(
        "639403125587-4k5hgdfumtrvur8v48e3pr7oo91d765k.apps.googleusercontent.com",
      ),

      // NEUROGLANCER_CREDIT_LINK: JSON.stringify({url: '...', text: '...'}),
      // NEUROGLANCER_DEFAULT_STATE_FRAGMENT: JSON.stringify('gs://bucket/state.json'),
      // NEUROGLANCER_SHOW_LAYER_BAR_EXTRA_BUTTONS: true,
      // NEUROGLANCER_SHOW_OBJECT_SELECTION_TOOLTIP: true

      // Standalone / dev edit-session backend (TM-349), supplied via `.env`
      // (see `.env.example`). All optional:
      //  - NEUROGLANCER_ZETTA_BACKEND_URL — root URL of the Zetta backend; the
      //    edit session's tools append their own API group (e.g.
      //    `/segmentation/propagate_mask`). Without it the backend is only
      //    reachable when an embedding host injects it via `configureBackend()`.
      //  - NEUROGLANCER_ZETTA_GOOGLE_CLIENT_ID_IAP — enables browser Google
      //    OAuth (client id only, NO secret) and sends the OIDC id_token as the
      //    bearer for an IAP-protected backend. Precedence over the static token.
      //  - NEUROGLANCER_ZETTA_BACKEND_TOKEN — static bearer token, DEV ONLY
      //    (ships in the bundle).
      ...zettaDefine("NEUROGLANCER_ZETTA_BACKEND_URL"),
      ...zettaDefine("NEUROGLANCER_ZETTA_GOOGLE_CLIENT_ID_IAP"),
      ...zettaDefine("NEUROGLANCER_ZETTA_BACKEND_TOKEN"),

      // NEUROGLANCER_GOOGLE_TAG_MANAGER: JSON.stringify('GTM-XXXXXX'),
    },
    watchOptions: {
      ignored: /node_modules/,
    },
  };
  return env.NEUROGLANCER_CLI
    ? config
    : normalizeConfigurationWithDefine(config);
};
