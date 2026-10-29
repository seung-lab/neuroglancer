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

/** Runtime-only reconstruction of self-contained inference recipes. */
import type { GetDataSourceOptions } from "#src/datasource/index.js";
import { publishLiveInference } from "#src/datasource/inference/frontend.js";
import { OnnxInferenceController } from "#src/inference/controller.js";
import type { PreparedInferenceInput } from "#src/inference/input.js";
import { prepareInferenceInput } from "#src/inference/input.js";
import { LiveInference } from "#src/inference/live.js";
import type { InferenceRecipe } from "#src/inference/recipe.js";
import {
  fetchInferenceModel,
  getInferenceRecipeGeometry,
  parseInferenceRecipe,
} from "#src/inference/recipe.js";
import { ImageUserLayer } from "#src/layer/image/index.js";
import type {
  ManagedUserLayer,
  TopLevelLayerListSpecification,
} from "#src/layer/index.js";
import { makeLayer } from "#src/layer/index.js";
import { StatusMessage } from "#src/status.js";
import { MessageSeverity } from "#src/util/message_list.js";

const contexts = new WeakMap<
  object,
  { root: TopLevelLayerListSpecification; references: number }
>();

/** Install before restoring URL state. Nothing in this registry is serialized. */
export function installInferenceRecipeContext(
  root: TopLevelLayerListSpecification,
): () => void {
  const key = root.coordinateSpace;
  let context = contexts.get(key);
  if (context === undefined) {
    context = { root, references: 0 };
    contexts.set(key, context);
  } else if (context.root !== root) {
    throw new Error(
      "Inference coordinate space already belongs to another viewer",
    );
  }
  ++context.references;
  const captured = context;
  let active = true;
  const dispose = () => {
    if (!active) return;
    active = false;
    if (--captured.references === 0 && contexts.get(key) === captured) {
      contexts.delete(key);
    }
  };
  return dispose;
}

/** Readiness also includes activation/load errors, not merely loading counters. */
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
        return finish(new Error("Inference source was disposed"));
      const image = layer.layer;
      if (!(image instanceof ImageUserLayer)) {
        return finish(new Error("Inference source is not an image layer"));
      }
      for (const source of image.dataSources) {
        if (source.loadState?.error !== undefined) {
          return finish(source.loadState.error);
        }
      }
      for (const message of image.messages) {
        if (message.severity === MessageSeverity.error) {
          return finish(new Error(message.message));
        }
      }
      if (layer.isReady()) {
        if (
          image.dataType.value === undefined ||
          image.renderLayers.length === 0
        ) {
          return finish(
            new Error("Inference source image data failed to activate"),
          );
        }
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

/** The returned handle owns the hidden input, worker and publication together. */
export async function restoreInferenceRecipe(
  options: GetDataSourceOptions,
  recipe: InferenceRecipe,
): Promise<{ url: string; dispose(): void }> {
  // Validate here too: callers other than the datasource must not bypass the
  // recursion guard or mutate settings while reconstruction is awaiting I/O.
  recipe = parseInferenceRecipe(recipe);
  options.signal.throwIfAborted();
  if (recipe.model.kind === "local") {
    throw new Error(
      `Local model ${recipe.model.name} is not included in shared state; load a model URL and rerun inference to create a shareable layer.`,
    );
  }
  const root = contexts.get(options.globalCoordinateSpace)?.root;
  if (root === undefined || root.wasDisposed) {
    throw new Error(
      "Inference recipe restoration requires an installed viewer context",
    );
  }
  const chunkManager = options.registry.chunkManager;
  if (chunkManager !== root.chunkManager || chunkManager.wasDisposed) {
    throw new Error(
      "Inference recipe viewer context does not match the ChunkManager",
    );
  }
  const abort = new AbortController();
  const { signal } = abort;
  let stopped = false;
  let disposed = false;
  let hidden: ManagedUserLayer | undefined;
  let input: PreparedInferenceInput | undefined;
  let controller: OnnxInferenceController | undefined;
  let live: LiveInference | undefined;
  let publication: { url: string; dispose(): void } | undefined;
  let status: StatusMessage | undefined;
  let removeInvalidation: (() => void) | undefined;
  const reportError = (error: unknown) => {
    if (disposed) return;
    status ??= new StatusMessage();
    status.setErrorMessage(
      `Restored inference ${recipe.source.name}: ${error instanceof Error ? error.message : error}`,
    );
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    removeInvalidation?.();
    abort.abort();
    live?.dispose();
    publication?.dispose();
    controller?.dispose();
    input?.dispose();
    hidden?.dispose();
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    options.signal.removeEventListener("abort", dispose);
    // RefCounted invokes its disposer array in reverse order. Do not mutate
    // that array while an owner is already reaching zero references.
    if (root.refCount !== 0) root.unregisterDisposer(dispose);
    if (chunkManager.refCount !== 0) chunkManager.unregisterDisposer(dispose);
    stop();
    status?.dispose();
  };
  options.signal.addEventListener("abort", dispose, { once: true });
  root.registerDisposer(dispose);
  chunkManager.registerDisposer(dispose);
  try {
    // Do not insert into root: this source is independent of visible layers,
    // names, session selection and inference dialog settings.
    hidden = makeLayer(root, recipe.source.name, {
      type: "image",
      source: recipe.source.source,
    });
    const image = await waitForSource(hidden, signal);
    signal.throwIfAborted();
    input = prepareInferenceInput(image, recipe.inputScaleIndex ?? 0);
    input.assertValid();
    if (recipe.spacingZYX.some((x, i) => x !== input!.spacingZYX[i])) {
      throw new Error(
        "Inference source native input voxel size changed from the saved recipe; confirm the source and rerun inference",
      );
    }
    const invalidate = () => {
      reportError(
        new Error(
          "Inference source changed; confirm the source and rerun inference",
        ),
      );
      // Retain the visible error until this output is deleted. Never remove the
      // saved layer/configuration as a side effect of source invalidation.
      stop();
    };
    input.signal?.addEventListener("abort", invalidate, { once: true });
    removeInvalidation = () =>
      input?.signal?.removeEventListener("abort", invalidate);
    if (input.signal?.aborted) invalidate();
    signal.throwIfAborted();
    const file = await fetchInferenceModel(recipe.model, signal);
    signal.throwIfAborted();
    controller = new OnnxInferenceController();
    // Restores have no open inference dialog: keep precision fallback visible,
    // including a first-execution fallback after publication or cancellation.
    controller.onMetadata = (metadata) => {
      if (disposed || stopped) return;
      if (metadata.precisionFallbackReason === undefined) {
        status?.dispose();
        status = undefined;
        return;
      }
      status ??= new StatusMessage();
      status.setText(
        `Restored inference ${recipe.source.name}: requested ${metadata.requestedPrecision}, actual ${metadata.actualPrecision} (${metadata.actualProvider}); ${metadata.precisionFallbackReason}`,
      );
    };
    const metadata = await controller.loadModel(
      file,
      recipe.provider,
      recipe.compatibilityFixes,
      recipe.precision,
    );
    signal.throwIfAborted();
    input.assertValid();
    const geometry = getInferenceRecipeGeometry(recipe, metadata);
    live = new LiveInference(
      controller,
      input,
      reportError,
      geometry,
      recipe.overlap,
    );
    const published = await publishLiveInference(chunkManager, live);
    // Publication RPC can complete after cancellation. Adopt or release it even
    // if stop() has already run; otherwise its worker tensor would leak.
    if (stopped) published.dispose();
    else publication = published;
    signal.throwIfAborted();
    input.assertValid();
    return { url: published.url, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
