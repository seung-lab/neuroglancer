/**
 * @license
 * Copyright 2018 The Neuroglancer Authors
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

 // import {FlowNetwork, FlowEdge} from 'js-graph-algorithms';
 // import {FlowNetwork} from 'js-graph-algorithms';

export interface Edge {
	src: number;
	dst: number;
	w: number;
}

export interface Subgraph {
	root: number;
	edges: Set<Edge>;
}

/**
 * Returns a js-graph-algorithms FlowNetwork object based on JSON from the
 * graph server.
 */
 // export function jsonToGraph(data: Subgraph) {
 // 	let edges = data.edges;
 // 	let vertices = [...new Set([...edges.map(function(i: Edge){return i.src}),
 // 					...edges.map(function(i: Edge){return i.dst})])];
 // 	let vertexToSegID = new Map<number, number>();
 // 	let segIDToVertex = new Map<number, number>();
 // 	vertices.map(function(v, k) {
 // 		vertexToSegID.set(k, v); 
 // 		segIDToVertex.set(v, k);
 // 	});
 // 	let g = new FlowNetwork(vertexToSegID.size);
 // 	// // console.log(edges)
 // 	for (let e of edges) {
 // 		let f = new FlowEdge(segIDToVertex.get(e.src), 
 // 								segIDToVertex.get(e.dst), 
 // 								e.w);
 // 		g.addEdge(f);
 // 		console.log(f)
 // 	}
 // 	return [g, vertexToSegID, segIDToVertex];
 // }

 