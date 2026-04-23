/**
 * @license
 * Copyright 2025 Zetta AI
 */

import { registerProvider } from "#src/datasource/default_provider.js";
import { CalcadaDataSource } from "#src/datasource/calcada/frontend.js";
import { KvStoreBasedDataSourceLegacyUrlAdapter } from "#src/datasource/index.js";

registerProvider(
  new KvStoreBasedDataSourceLegacyUrlAdapter(new CalcadaDataSource()),
);
