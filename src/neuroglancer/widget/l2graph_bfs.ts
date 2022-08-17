// TODO: rename this file to something more appropriate.
/**
 * @license
 * Copyright 2018 Google Inc.
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

import {authFetch} from '../authentication/frontend';

// given an array of edges, construct an adjacency map.
function constructAdjacencyMap(edges: string[]): Map<string, Set<string>> {
  const adjacencyMap = new Map<string, Set<string>>();
  for (const edge of edges) {
    const source = edge[0];
    const target = edge[1];
    if (!adjacencyMap.has(source)) {
      adjacencyMap.set(source, new Set<string>());
    }
    if (!adjacencyMap.has(target)) {
      adjacencyMap.set(target, new Set<string>());
    }
    adjacencyMap.get(source)!.add(target);
    adjacencyMap.get(target)!.add(source);
  }
  return adjacencyMap;
}

// given an adjacency map, the index of the starting node, and the maximum, return the BFS
// traversal, pairing each node with its distance from the starting node.
function bfs(
    adjacencyMap: Map<string, Set<string>>, start: string, max: number): Map<string, number> {
  const visited = new Set<string>();
  const queue = new Array<[string, number]>();
  const distances = new Map<string, number>();
  queue.push([start, 0]);
  while (queue.length > 0) {
    const [node, distance] = queue.shift()!;
    if (distance > max) {
      break;
    }
    if (visited.has(node)) {
      continue;
    }
    visited.add(node);
    distances.set(node, distance);
    if (adjacencyMap.has(node)) {
      for (const neighbor of adjacencyMap.get(node)!) {
        queue.push([neighbor, distance + 1]);
      }
    }
  }
  return distances;
}

const url = 'https://prod.flywire-daf.com/segmentation/api/v1/table/';
const table = 'fly_v31';
async function L2GraphBFS(rootId: string, distance: number): Promise<Map<string, number>> {
  const response = await authFetch(`${url}/${table}/node/${rootId}/lvl2_graph?int64_as_str=1`);
  const json = await response.json();
  const edges = json['edge_graph'];
  /*
   {
  method: 'POST',
  body: JSON.stringify([
    [String(first.rootId), ...first.position.values()],
    [String(second.rootId), ...second.position.values()]
  ])
}
   */
  // just use the first edge for now.
  const start = edges[0][0];
  const adjacencyMap = constructAdjacencyMap(edges);
  return bfs(adjacencyMap, start, distance);
}

export {L2GraphBFS};