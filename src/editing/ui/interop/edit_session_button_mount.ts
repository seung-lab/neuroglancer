/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { NgLayerMetadataSource } from "#src/editing/adapters/ng_layer_metadata_source.js";
import type { EditSessionHost } from "#src/editing/edit_session_host.js";
import { mountComponent } from "#src/editing/ui/interop/component_mount.js";
import { EnterEditSessionButton } from "#src/editing/ui/session_entry/enter_edit_session_button.js";
import type { LayerManager } from "#src/layer/index.js";
import { RefCounted } from "#src/util/disposable.js";

export class EditSessionButtonMount extends RefCounted {
  readonly element: HTMLElement;

  constructor(
    host: EditSessionHost,
    layerManager: LayerManager,
    metadataSource: NgLayerMetadataSource,
  ) {
    super();
    this.element = document.createElement("div");
    this.element.style.display = "contents";
    this.registerDisposer(
      mountComponent(this.element, EnterEditSessionButton, {
        host,
        layerManager,
        metadataSource,
      }),
    );
  }
}
