/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { createPortal } from "preact/compat";
import { useEffect, useMemo, useState } from "preact/hooks";

import type { NgLayerMetadataSource } from "#src/editing/adapters/ng_layer_metadata_source.js";
import type { EditSessionHost } from "#src/editing/edit_session_host.js";
import { useSignal } from "#src/editing/ui/interop/use_signal.js";
import { BboxSelectionModel } from "#src/editing/ui/session_entry/bbox_candidates.js";
import { SessionEntryModal } from "#src/editing/ui/session_entry/session_entry.js";
import type { LayerManager } from "#src/layer/index.js";
import { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import { StatusMessage } from "#src/status.js";

export function EnterEditSessionButton(props: {
  host: EditSessionHost;
  layerManager: LayerManager;
  metadataSource: NgLayerMetadataSource;
}) {
  const { host, layerManager, metadataSource } = props;

  const bboxModel = useMemo(
    () => new BboxSelectionModel(layerManager),
    [layerManager],
  );
  useEffect(() => () => bboxModel.dispose(), [bboxModel]);

  useSignal(host.activeSession.changed);
  useSignal(layerManager.layersChanged);
  useSignal(bboxModel.entriesChanged);

  const sessionActive = host.activeSession.value !== undefined;
  const disabled =
    sessionActive ||
    !hasWritableSegmentationLayer(layerManager) ||
    !bboxModel.hasBboxAnnotation();

  const [modalOpen, setModalOpen] = useState(false);

  const handleClick = () => {
    if (sessionActive) {
      StatusMessage.showTemporaryMessage(
        "Discard the current session before starting a new one.",
        4000,
      );
      return;
    }
    setModalOpen(true);
  };

  return (
    <>
      <button
        type="button"
        class="neuroglancer-enter-edit-session-button"
        title="Open a voxel edit session"
        disabled={disabled}
        onClick={handleClick}
      >
        Enter Edit Session
      </button>
      {modalOpen &&
        createPortal(
          <SessionEntryModal
            host={host}
            layerManager={layerManager}
            metadataSource={metadataSource}
            bboxModel={bboxModel}
            onClose={() => setModalOpen(false)}
          />,
          document.body,
        )}
    </>
  );
}

function hasWritableSegmentationLayer(layerManager: LayerManager): boolean {
  for (const managed of layerManager.managedLayers) {
    if (
      managed.layer instanceof SegmentationUserLayer &&
      managed.layer.isReady
    ) {
      return true;
    }
  }
  return false;
}
