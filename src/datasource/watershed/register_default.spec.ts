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
import { installWatershedDataSourceProvider } from "#src/datasource/watershed/register_default.js";
import { dataSourceProviderFixture } from "#tests/fixtures/datasource_provider.js";

const registryFixture = dataSourceProviderFixture();

it("lazily installs session-local watershed in the GL-free default registry", async () => {
  // Node has no WebGL2RenderingContext: eager volume frontend imports fail here.
  const registry = await registryFixture();
  expect(registry.getProvider("watershed://abc")[0].scheme).toBe("watershed");
  installWatershedDataSourceProvider(registry);
  expect(registry.getProvider("watershed://abc")[0].scheme).toBe("watershed");
  const completion = await registry.completeUrl({ url: "" });
  expect(
    completion.completions.some(({ value }) => value === "watershed://"),
  ).toBe(false);
});
