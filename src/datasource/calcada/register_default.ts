/**
 * @license
 * Copyright 2025 Zetta AI
 */

import { CalcadaDataSource } from "#src/datasource/calcada/frontend.js";
import { registerProvider } from "#src/datasource/default_provider.js";
import { KvStoreBasedDataSourceLegacyUrlAdapter } from "#src/datasource/index.js";

registerProvider(
  new KvStoreBasedDataSourceLegacyUrlAdapter(new CalcadaDataSource()),
);
