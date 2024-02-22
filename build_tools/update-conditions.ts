import fs from "node:fs";
import path from "node:path";

import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const packageJsonPath = path.resolve(rootDir, "package.json");

const packageJson = JSON.parse(
  await fs.promises.readFile(packageJsonPath, { encoding: "utf-8" }),
);

const JS_EXT = ".ts";

const NOOP = "./src/util/false" + JS_EXT;

const imports: Record<string, any> = {};
imports["#src/third_party/jpgjs/jpg.js"] = "./src/third_party/jpgjs/jpg.js";
imports["#src/*.js"] = "./src/*.ts";
imports["#src/*"] = "./src/*";
imports["#testdata/*"] = "./testdata/*";

const datasourceDir = path.resolve(rootDir, "src", "datasource");
const layerDir = path.resolve(rootDir, "src", "layer");

const datasources = (
  await fs.promises.readdir(datasourceDir, { withFileTypes: true })
)
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

const layers = (await fs.promises.readdir(layerDir, { withFileTypes: true }))
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

const datasourceKeys = {
  backend: "backend",
  async_computation: "async_computation",
  register_default: "frontend",
  register_credentials_provider: "frontend",
} as const;

const datasourceModules = Object.fromEntries(
  Object.values(datasourceKeys).map((key) => [key, new Array<string>()]),
);

for (const datasource of datasources) {
  for (const [filePrefix, moduleKind] of Object.entries(datasourceKeys)) {
    const sourcePrefix = `./src/datasource/${datasource}/${filePrefix}`;
    if (
      await fs.promises
        .stat(path.resolve(rootDir, `${sourcePrefix}.ts`))
        .catch(() => undefined)
    ) {
      const source = sourcePrefix + JS_EXT;
      const conditions: Record<string, string> = {};
      if (datasource === "python") {
        conditions["neuroglancer/python"] = source;
        conditions.default = NOOP;
      } else {
        if (filePrefix === "register_credentials_provider") {
          conditions["neuroglancer/python"] = NOOP;
        }
        conditions[`neuroglancer/datasource/${datasource}:enabled`] = source;
        conditions["neuroglancer/datasource:none_by_default"] = NOOP;
        conditions[`neuroglancer/datasource/${datasource}:disabled`] = source;
        conditions.default = source;
      }
      const moduleId = `#datasource/${datasource}/${filePrefix}`;
      imports[moduleId] = conditions;
      datasourceModules[moduleKind].push(moduleId);
    }
  }
}

for (const layer of layers) {
  const source = `./src/layer/${layer}/index` + JS_EXT;
  imports[`#layer/${layer}`] = {
    [`neuroglancer/layer/${layer}:enabled`]: source,
    "neuroglancer/layer:none_by_default": NOOP,
    [`neuroglancer/layer/${layer}:enabled`]: source,
    default: source,
  };
}

// main entrypoint.
imports["#main"] = {
  "neuroglancer/python": "./src/main_python" + JS_EXT,
  default: "./src/main" + JS_EXT,
};

// main entrypoint.
imports["#python_integration_build"] = {
  "neuroglancer/python": "./src/util/true" + JS_EXT,
  default: NOOP,
};

async function writeModule(modulePath: string, imports: string[]) {
  await fs.promises.writeFile(
    modulePath,
    "// DO NOT EDIT: Generated by config/update_conditions.ts\n" +
      imports.map((name) => `import ${JSON.stringify(name)};\n`).join(""),
    { encoding: "utf-8" },
  );
}

for (const [moduleKind, moduleIds] of Object.entries(datasourceModules)) {
  await writeModule(
    path.resolve(
      rootDir,
      "src",
      "datasource",
      `enabled_${moduleKind}_modules.ts`,
    ),
    moduleIds,
  );
}

await writeModule(
  path.resolve(rootDir, "src", "layer", "enabled_frontend_modules.ts"),
  layers.map((name) => `#layer/${name}`),
);

packageJson.imports = imports;

packageJson.exports = {
  ".": "./src/main_module.ts",
  "./*.js": "./src/*.ts",
  "./*": "./src/*",
};

const tempPackageJsonPath = packageJsonPath + ".tmp";

await fs.promises.writeFile(
  tempPackageJsonPath,
  JSON.stringify(packageJson, undefined, 2) + "\n",
  { encoding: "utf-8" },
);
await fs.promises.rename(tempPackageJsonPath, packageJsonPath);