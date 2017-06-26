
import {Uint64} from 'neuroglancer/util/uint64';
import {CancellablePromise} from 'neuroglancer/util/promise';
import {openHttpRequest, sendHttpRequest, HttpError} from 'neuroglancer/util/http_request';


export const GRAPH_SERVER_NOT_ENABLED = Symbol('Graph Server Not Enabled.');

let GRAPH_BASE_URL = '';

export function enableGraphServer (url: string) : void {
  GRAPH_BASE_URL = url;
}

export function getRoot (segment: Uint64) : Promise<Uint64> {
  if (!GRAPH_BASE_URL) {
    return Promise.reject(GRAPH_SERVER_NOT_ENABLED);
  }

  let promise = sendHttpRequest(openHttpRequest(`${GRAPH_BASE_URL}/1.0/segment/${segment}/root`), 'arraybuffer');
  return promise.then(response => {
    let uint32 = new Uint32Array(response);
    return new Uint64(uint32[0], uint32[1]);
  }).catch((e: HttpError) => {
    console.log(`Could not retrieve root for segment ${segment}`);
    console.error(e);

    return Promise.reject(e);
  });
}

export function getLeaves (segment: Uint64) : Promise<Uint64[]> {
  if (!GRAPH_BASE_URL) {
    return Promise.reject(GRAPH_SERVER_NOT_ENABLED);
  }

  let promise = sendHttpRequest(openHttpRequest(`${GRAPH_BASE_URL}/1.0/segment/${segment}/leaves`), 'arraybuffer');
  return promise.then(response => {
    let uint32 = new Uint32Array(response);
    let final : Uint64[] = new Array(uint32.length/2);

    for (let i = 0; i < uint32.length/2; i++) {
      final[i] = new Uint64(uint32[2*i], uint32[2*i+1]);
    }

    return final;
  }).catch((e: HttpError) => {
    console.log(`Could not retrieve connected components for segment ${segment}`);
    console.error(e);

    return Promise.reject(e);
  });
}

export function getChildren(segment: Uint64) : Promise<Uint64[]> {
  if (!GRAPH_BASE_URL) {
    return Promise.reject(GRAPH_SERVER_NOT_ENABLED);
  }

  let promise = sendHttpRequest(openHttpRequest(`${GRAPH_BASE_URL}/1.0/segment/${segment}/children`), 'arraybuffer');
  return promise.then(response => {
    let uint32 = new Uint32Array(response);
    let final : Uint64[] = new Array(uint32.length/2);

    for (let i = 0; i < uint32.length/2; i++) {
      final[i] = new Uint64(uint32[2*i], uint32[2*i+1]);
    }

    return final;
  }).catch((e: HttpError) => {
    console.log(`Could not retrieve children for segment ${segment}`);
    console.error(e);

    return Promise.reject(e);
  });
}

/* Directs the graph server to merge 
 * the given nodes into a single object.
 * 
 * This will remove them from other objects.
 */
export function mergeNodes<T> (nodes: T[]) : Promise<any> {
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
export function getObjectList () : Promise<any> {
  return fetch(`${GRAPH_BASE_URL}/1.0/object/`)
    .then(function (response: Response) {
      return response.json();
    }, function (error) {
      console.error(error);
    });
}

export function splitObject (source: Uint64, sink: Uint64) : Promise<any> {
  let a = source;
  let b = sink;
  // return fetch(`${GRAPH_BASE_URL}/1.0/split/`, {

  //   method: "POST",
  //   body: JSON.stringify({
  //     sources: source,
  //     sinks: sink,
  //   })
  // })
  // .then( (resp) => resp.json(), (error) => error )
  // .then( (split_groups: any) => { // this typing is stupid but was the only way to surpress TS errors
  //   if (split_groups.error) {
  //     throw new Error(split_groups.error);
  //   }

  //   return <Uint64[][]>((<number[][]>split_groups).map( (nums) => nums.map( (num) => new Uint64(num) ) ));
  // }, (error) => error );
  return null;
}

