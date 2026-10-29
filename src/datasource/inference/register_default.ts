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

import type { DataSourceRegistry } from "#src/datasource/index.js";

/** Also usable with custom registries; repeated installation is harmless. */
export function installInferenceDataSourceProvider(
  registry: DataSourceRegistry,
) {
  registry.register({
    scheme: "inference",
    description: "Shareable inference recipe or legacy session-local result",
    // Recipes require accompanying state; legacy URLs require a publication.
    // Neither can be created from an empty scheme completion.
    hidden: true,
    async get(options) {
      // Default registries are also used by GL-free tools and Node tests. Do not
      // load volume rendering dependencies until an inference URL is resolved.
      const { InferenceDataSourceProvider } = await import(
        "#src/datasource/inference/frontend.js"
      );
      return new InferenceDataSourceProvider().get(options);
    },
  });
}
