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

 import {} from 'neuroglancer/chunked_graph/frontend';

/* Need to:
 - maintain list of operations requested
 	- operations should have associated states: 
 		- requested: client has submitted operation to MASTER, but has not received acknowledgement
 		- queued: client has received acknowledgment of operation receipt by MASTER
 		- completed: client has received acknowledgement of operation being executed by MASTER
 		- ignored: client has received acknowledgment that MASTER decided to not execute oepration
 		- (deleted): client has decided to undo a previous operation and has not received acknowledgment from MASTER of execution or ignoring
 	- should have a second list of operations that simulate sequentiality for the undo operation
 - maintain list of mesh objects
 	- meshes should subscribe to pub/sub for if they become stale
 	- see neuroglancer/segmentation_display_state
 	- can remove getChildren from neuroglancer/chunked_graph/backend &
 	  neuroglancer/mesh/backend
 - maintain list of supervoxels in display window (optional) 
 - how to undo operations?
 	- split between connected components should be removing an edge
*/


 describe('chunked_graph/frontend', () => {
 	it('merge', () => {
 		expect(
 			merge
 			);
 	}),
 	it('split', () => {
 		expect(
 			);
 	})
 	it('addOperation', () => {
 		expect(
 			);
 	})
 	it('setOperationState', () => {
 		expect(
 			);
 	})
 })