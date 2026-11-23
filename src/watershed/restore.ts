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

import type { GetDataSourceOptions } from "#src/datasource/index.js";
import { publishLiveWatershed } from "#src/datasource/watershed/frontend.js";
import { ImageUserLayer } from "#src/layer/image/index.js";
import type { ManagedUserLayer } from "#src/layer/index.js";
import { makeLayer } from "#src/layer/index.js";
import { StatusMessage, statusMessages } from "#src/status.js";
import { MessageSeverity } from "#src/util/message_list.js";
import type { Viewer } from "#src/viewer.js";
import type { PreparedAffinityInput } from "#src/watershed/input.js";
import { prepareAffinityInput } from "#src/watershed/input.js";
import { LiveWatershed } from "#src/watershed/live.js";
import type { WatershedRecipe } from "#src/watershed/recipe.js";
import { parseWatershedRecipe } from "#src/watershed/recipe.js";
import { watchWatershedViewport } from "#src/watershed/viewport.js";

const contexts = new WeakMap<object, { viewer: Viewer; references: number }>();

/** Install before URL state is restored. The viewer is borrowed, not retained. */
export function installWatershedRecipeContext(viewer: Viewer): () => void {
  const key = viewer.layerSpecification.coordinateSpace;
  let context = contexts.get(key);
  if (context === undefined) {
    context = { viewer, references: 0 };
    contexts.set(key, context);
  } else if (context.viewer !== viewer) {
    throw new Error(
      "Watershed coordinate space already belongs to another viewer",
    );
  }
  ++context.references;
  const captured = context;
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    if (--captured.references === 0 && contexts.get(key) === captured)
      contexts.delete(key);
  };
}

function waitForSource(
  layer: ManagedUserLayer,
  signal: AbortSignal,
): Promise<ImageUserLayer> {
  return new Promise((resolve, reject) => {
    const removers: Array<() => void> = [];
    let finished = false;
    const finish = (error?: unknown, image?: ImageUserLayer) => {
      if (finished) return;
      finished = true;
      for (const remove of removers.splice(0)) remove();
      if (image !== undefined) resolve(image);
      else reject(error);
    };
    const check = () => {
      if (signal.aborted) return finish(signal.reason);
      if (layer.wasDisposed)
        return finish(new Error("Watershed affinity source was disposed"));
      const image = layer.layer;
      if (!(image instanceof ImageUserLayer))
        return finish(
          new Error("Watershed affinity source is not an image layer"),
        );
      for (const source of image.dataSources) {
        if (source.loadState?.error !== undefined)
          return finish(source.loadState.error);
      }
      for (const message of image.messages) {
        if (message.severity === MessageSeverity.error)
          return finish(new Error(message.message));
      }
      if (layer.isReady()) {
        if (
          image.dataType.value === undefined ||
          image.renderLayers.length === 0
        )
          return finish(
            new Error("Watershed affinity source failed to activate"),
          );
        finish(undefined, image);
      }
    };
    removers.push(
      layer.readyStateChanged.add(check),
      layer.layerChanged.add(check),
    );
    const image = layer.layer;
    if (image !== null) {
      removers.push(
        image.dataSourcesChanged.add(check),
        image.messages.changed.add(check),
      );
    }
    signal.addEventListener("abort", check, { once: true });
    removers.push(() => signal.removeEventListener("abort", check));
    check();
  });
}

/** Reconstruct an independent input and producer, then bind at layer activation. */
export async function restoreWatershedRecipe(
  options: GetDataSourceOptions,
  recipe: WatershedRecipe,
): Promise<{
  url: string;
  dispose(): void;
  attach(layer: ManagedUserLayer): () => void;
}> {
  recipe = parseWatershedRecipe(recipe);
  options.signal.throwIfAborted();
  const viewer = contexts.get(options.globalCoordinateSpace)?.viewer;
  const root = viewer?.layerSpecification;
  if (
    viewer === undefined ||
    viewer.wasDisposed ||
    root === undefined ||
    root.wasDisposed
  )
    throw new Error(
      "Watershed recipe restoration requires an installed viewer context",
    );
  const chunkManager = options.registry.chunkManager;
  if (chunkManager !== root.chunkManager || chunkManager.wasDisposed)
    throw new Error(
      "Watershed recipe viewer context does not match the ChunkManager",
    );
  const abort = new AbortController();
  const { signal } = abort;
  let disposed = false;
  let stopped = false;
  let hidden: ManagedUserLayer | undefined;
  let input: PreparedAffinityInput | undefined;
  let live: LiveWatershed | undefined;
  let publication: { url: string; dispose(): void } | undefined;
  let removeInvalidation: (() => void) | undefined;
  let detach: (() => void) | undefined;
  let status: StatusMessage | undefined;
  const clearError = () => {
    if (status !== undefined && statusMessages.has(status)) status.dispose();
    status = undefined;
  };
  const reportError = (error: unknown) => {
    if (disposed) return;
    if (status === undefined || !statusMessages.has(status))
      status = new StatusMessage();
    status.setErrorMessage(
      `Restored watershed ${recipe.source.name}: ${error instanceof Error ? error.message : error}`,
    );
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    detach?.();
    removeInvalidation?.();
    abort.abort();
    publication?.dispose();
    live?.dispose();
    input?.dispose();
    hidden?.dispose();
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    options.signal.removeEventListener("abort", dispose);
    if (root.refCount !== 0) root.unregisterDisposer(dispose);
    if (chunkManager.refCount !== 0) chunkManager.unregisterDisposer(dispose);
    stop();
    clearError();
  };
  options.signal.addEventListener("abort", dispose, { once: true });
  root.registerDisposer(dispose);
  chunkManager.registerDisposer(dispose);
  try {
    hidden = makeLayer(root, recipe.source.name, {
      type: "image",
      source: recipe.source.source,
    });
    const image = await waitForSource(hidden, signal);
    signal.throwIfAborted();
    input = prepareAffinityInput(image, recipe.inputScaleIndex);
    input.assertValid();
    if (recipe.spacingXYZ.some((n, i) => n !== input!.spacingXYZ[i]))
      throw new Error(
        "Watershed source native voxel size changed from the saved recipe; confirm the source and add a new watershed layer",
      );
    const preparedInput = input;
    live = new LiveWatershed(
      preparedInput,
      recipe.channelsXYZ,
      recipe.options,
      reportError,
      recipe.halo,
    );
    input = undefined;
    const producer = live;
    const invalidate = () => {
      if (stopped) return;
      reportError(
        new Error("Affinity source changed; add a new watershed layer"),
      );
      // Keep the saved layer and its recipe visible, but never stale labels.
      stop();
    };
    live.signal.addEventListener("abort", invalidate, { once: true });
    const removeRecovery = producer.changed.add(() => {
      if (!stopped && !producer.signal.aborted) clearError();
    });
    removeInvalidation = () => {
      producer.signal.removeEventListener("abort", invalidate);
      removeRecovery();
    };
    live.signal.throwIfAborted();
    publication = publishLiveWatershed(chunkManager, live);
    signal.throwIfAborted();
    return {
      url: publication.url,
      dispose,
      attach(layer) {
        if (stopped || layer.wasDisposed) return () => {};
        detach?.();
        let active = true;
        let unwatch: ReturnType<typeof watchWatershedViewport> = () => {};
        const cleanup = () => {
          if (!active) return;
          active = false;
          unwatch();
          if (detach === cleanup) detach = undefined;
          if (!stopped && !producer.signal.aborted) {
            producer.setViewportRefresh(undefined);
            producer.setViewport(undefined);
          }
        };
        detach = cleanup;
        unwatch = watchWatershedViewport(
          viewer,
          preparedInput,
          layer,
          (region) => {
            if (!active || stopped) return;
            producer.setViewport(region);
          },
          (error) => {
            if (!active || stopped) return;
            producer.setViewportError(error);
          },
        );
        if (!active) unwatch();
        else producer.setViewportRefresh(unwatch.refresh);
        return cleanup;
      },
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
