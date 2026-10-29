/**
 * @license
 * Copyright 2026 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { expect, it } from "vitest";
import { installInferenceDataSourceProvider } from "#src/datasource/inference/register_default.js";
import { dataSourceProviderFixture } from "#tests/fixtures/datasource_provider.js";

const registryFixture = dataSourceProviderFixture();

it("installs inference in the default registry without importing rendering dependencies", async () => {
  // This runs in Node without WebGL globals. Importing the volume frontend here
  // would fail before registration (WebGL2RenderingContext is not defined).
  const registry = await registryFixture();
  expect(registry.getProvider("inference://session-result")[0].scheme).toBe(
    "inference",
  );
  installInferenceDataSourceProvider(registry);
  expect(registry.getProvider("inference://session-result")[0].scheme).toBe(
    "inference",
  );
  const completion = await registry.completeUrl({ url: "" });
  expect(
    completion.completions.some(({ value }) => value === "inference://"),
  ).toBe(false);
});
