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

 import {FlowNetwork, FlowEdge} from 'js-graph-algorithms';

/**
 * Returns a js-graph-algorithms FlowNetwork object based on JSON from the
 * graph server.
 */
 export function jsonToGraph(obj: object) {
 	let edges = obj.edges;
 	let nodes = [...new Set([...edges.map(function(i: any){return i.src}),
 					...edges.map(function(i: any){return i.dst})])];
 	let g: FlowNetwork = new FlowNetwork(nodes.length);
 	for (let e in edges){
 		g.addEdge(new FlowEdge(e.src, e.dst, e.w));
 	}
 	return g;
 }

 