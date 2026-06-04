/**
 * @license
 * Copyright 2025 Google Inc.
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

import { SimpleAsyncCache } from "#src/chunk_manager/generic_file_source.js";
import type { SharedKvStoreContextCounterpart } from "#src/kvstore/backend.js";
import type { BtreeNode } from "#src/kvstore/ocdbt/btree.js";
import { decodeBtreeNode } from "#src/kvstore/ocdbt/btree.js";
import type {
  DataFileId,
  IndirectDataReference,
} from "#src/kvstore/ocdbt/indirect_data_reference.js";
import type {
  Manifest,
  ManifestWithVersionTree,
} from "#src/kvstore/ocdbt/manifest.js";
import { decodeManifest } from "#src/kvstore/ocdbt/manifest.js";
import type { VersionSpecifier } from "#src/kvstore/ocdbt/version_specifier.js";
import type {
  BtreeGenerationReference,
  VersionTreeNode,
} from "#src/kvstore/ocdbt/version_tree.js";
import { decodeVersionTreeNode } from "#src/kvstore/ocdbt/version_tree.js";
import { pipelineUrlJoin } from "#src/kvstore/url.js";
import type { ProgressOptions } from "#src/util/progress_listener.js";
import { ProgressSpan } from "#src/util/progress_listener.js";

export function getManifest(
  sharedKvStoreContext: SharedKvStoreContextCounterpart,
  dataFile: DataFileId,
  options: Partial<ProgressOptions>,
): Promise<Manifest> {
  const cache = sharedKvStoreContext.chunkManager.memoize.get(
    "ocdbt:manifest",
    () => {
      const cache = new SimpleAsyncCache<DataFileId, Manifest>(
        sharedKvStoreContext.chunkManager.addRef(),
        {
          get: async (
            dataFile: DataFileId,
            progressOptions: ProgressOptions,
          ) => {
            const fullUrl = pipelineUrlJoin(
              dataFile.baseUrl,
              dataFile.relativePath,
            );
            using _span = new ProgressSpan(progressOptions.progressListener, {
              message: `Reading OCDBT manifest from ${fullUrl}`,
            });
            const readResponse = await sharedKvStoreContext.kvStoreContext.read(
              fullUrl,
              {
                ...progressOptions,
                throwIfMissing: true,
              },
            );
            try {
              const manifest = await decodeManifest(
                await readResponse.response.arrayBuffer(),
                dataFile.baseUrl,
                progressOptions.signal,
              );
              return { data: manifest, size: manifest.estimatedSize };
            } catch (e) {
              throw new Error(`Error reading OCDBT manifest from ${fullUrl}`, {
                cause: e,
              });
            }
          },
        },
      );
      cache.registerDisposer(sharedKvStoreContext.addRef());
      return cache;
    },
  );
  return cache.get(dataFile, options);
}

// Invalidate cached OCDBT metadata for a specific database so the next read
// resolves a fresh root from the updated manifest. Only `ocdbt:manifest`
// (per `{baseUrl, "manifest.ocdbt"}`) and `ocdbt:version` (per
// `{url: baseUrl, version}`) can hold stale entries after a server-side
// write; `ocdbt:btree` and `ocdbt:versionnode` are content-addressed by
// `dataFile` location and self-correct (a new manifest references new
// locations; old entries simply go unreferenced).
//
// `baseUrl` and `version` MUST come from the `OcdbtKvStore` whose cache is
// being invalidated, since those are the exact keys used to populate the
// caches. Resolve via `kvStoreContext.getKvStore(...)` first when the
// caller only knows a pipeline URL like `kvstack:...|ocdbt:`.
//
// Safe to call when the caches haven't been populated yet (no-op).
export function invalidateOcdbtCaches(
  sharedKvStoreContext: SharedKvStoreContextCounterpart,
  baseUrl: string,
  version: VersionSpecifier | undefined,
) {
  const { memoize } = sharedKvStoreContext.chunkManager;
  const manifestCache =
    memoize.getIfExists<SimpleAsyncCache<DataFileId, Manifest>>(
      "ocdbt:manifest",
    );
  if (manifestCache !== undefined) {
    try {
      manifestCache.invalidate({ baseUrl, relativePath: "manifest.ocdbt" });
    } finally {
      manifestCache.dispose();
    }
  }
  const versionCache =
    memoize.getIfExists<
      SimpleAsyncCache<
        { url: string; version: VersionSpecifier | undefined },
        BtreeGenerationReference
      >
    >("ocdbt:version");
  if (versionCache !== undefined) {
    try {
      versionCache.invalidate({ url: baseUrl, version });
    } finally {
      versionCache.dispose();
    }
  }
}

export async function getResolvedManifest(
  sharedKvStoreContext: SharedKvStoreContextCounterpart,
  url: string,
  options: Partial<ProgressOptions>,
): Promise<ManifestWithVersionTree> {
  const manifest = await getManifest(
    sharedKvStoreContext,
    { baseUrl: url, relativePath: "manifest.ocdbt" },
    options,
  );
  if (manifest.versionTree === undefined) {
    throw new Error("only manifest_kind=single is supported");
  }
  return manifest as ManifestWithVersionTree;
}

function makeIndirectDataReferenceCache<T extends { estimatedSize: number }>(
  sharedKvStoreContext: SharedKvStoreContextCounterpart,
  description: string,
  decode: (
    data: ArrayBuffer,
    baseUrl: string,
    signal: AbortSignal,
  ) => Promise<T>,
) {
  const cache = new SimpleAsyncCache<IndirectDataReference, T>(
    sharedKvStoreContext.chunkManager.addRef(),
    {
      get: async (
        location: IndirectDataReference,
        progressOptions: ProgressOptions,
      ) => {
        const { dataFile } = location;
        const fullUrl = pipelineUrlJoin(
          dataFile.baseUrl,
          dataFile.relativePath,
        );
        const readResponse = await sharedKvStoreContext.kvStoreContext.read(
          fullUrl,
          {
            ...progressOptions,
            throwIfMissing: true,
            byteRange: {
              offset: Number(location.offset),
              length: Number(location.length),
            },
          },
        );
        try {
          const node = await decode(
            await readResponse.response.arrayBuffer(),
            dataFile.baseUrl,
            progressOptions.signal,
          );
          return { data: node, size: node.estimatedSize };
        } catch (e) {
          throw new Error(
            `Error reading OCDBT ${description} from ${fullUrl}`,
            {
              cause: e,
            },
          );
        }
      },
      encodeKey: ({ dataFile, offset, length }) =>
        JSON.stringify([dataFile, `${offset}/${length}`]),
    },
  );
  cache.registerDisposer(sharedKvStoreContext.addRef());
  return cache;
}

export function getBtreeNode(
  sharedKvStoreContext: SharedKvStoreContextCounterpart,
  location: IndirectDataReference,
  options: Partial<ProgressOptions>,
): Promise<BtreeNode> {
  const cache = sharedKvStoreContext.chunkManager.memoize.get(
    "ocdbt:btree",
    () =>
      makeIndirectDataReferenceCache(
        sharedKvStoreContext,
        "b+tree node",
        decodeBtreeNode,
      ),
  );
  return cache.get(location, options);
}

export function getVersionTreeNode(
  sharedKvStoreContext: SharedKvStoreContextCounterpart,
  location: IndirectDataReference,
  options: Partial<ProgressOptions>,
): Promise<VersionTreeNode> {
  const cache = sharedKvStoreContext.chunkManager.memoize.get(
    "ocdbt:versionnode",
    () =>
      makeIndirectDataReferenceCache(
        sharedKvStoreContext,
        "version tree node",
        decodeVersionTreeNode,
      ),
  );
  return cache.get(location, options);
}
