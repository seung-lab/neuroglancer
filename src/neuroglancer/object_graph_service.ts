
import {Uint64} from 'neuroglancer/util/uint64';
import {CancellablePromise} from 'neuroglancer/util/promise';
import {openHttpRequest, sendHttpRequest} from 'neuroglancer/util/http_request';


let GRAPH_BASE_URL = 'http://localhost:8888';

export function setGraphServerURL (url: string) : void {
	GRAPH_BASE_URL = url;
}

export function getConnectedSegments (segment: Uint64) : CancellablePromise<Uint64[]> {
	let promise = sendHttpRequest(openHttpRequest(`${GRAPH_BASE_URL}/1.0/node/${segment}`), 'arraybuffer');
    return promise.then(
      response => {
        let uint32 = new Uint32Array(response);
        let final : Uint64[] = new Array(uint32.length);

        for (let i = 0; i < uint32.length; i++) {
        	final[i] = new Uint64(uint32[i]);
        }

        return final;
      },
      function (e) {
        console.log(`Download failed for segment ${segment}`);
        console.error(e);
      });
}

/* Directs the graph server to merge 
 * the given nodes into a single object.
 * 
 * This will remove them from other objects.
 */
export function mergeNodes<T> (nodes: T[]) : Promise<Response> {
	return fetch(`${GRAPH_BASE_URL}/1.0/object/`, {
	  method: "POST",
	  body: JSON.stringify(nodes),
	})
	.catch(function (error) {
		console.error(error);
	})
	.then(function (resp) {
		console.log("yay merged");
		return resp;
	});
}

/* Fetches all registered objects in the dataset
 * with their nodes. Not scalable, will be chunked in future.
 */
export function getObjectList () : Promise<Response> {
	return fetch(`${GRAPH_BASE_URL}/1.0/object/`)
		.catch(function (error) {
			console.error(error);
		})
		.then(function (response) {
			return response.json();
		});
}

export function splitObject (sources: Uint64[], sinks: Uint64[]) {
	return fetch(`${GRAPH_BASE_URL}/1.0/split/`, {
		method: "POST",
		body: JSON.stringify({
			sources: sources,
			sinks: sinks,
		})
	})
	.catch(function (error) {
		console.error(error);
	})
	.then( (resp) => resp.json() )
	.catch( (err) => console.error(err) )
	.then( (split_groups: any) => { // this typing is stupid but was the only way to surpress TS errors
		return <Uint64[][]>((<number[][]>split_groups).map( (nums) => nums.map( (num) => new Uint64(num) ) ));
	});
}

