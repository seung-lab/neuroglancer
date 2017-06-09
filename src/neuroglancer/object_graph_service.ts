
import {Uint64} from 'neuroglancer/util/uint64';
import {openHttpRequest, sendHttpRequest, HttpError} from 'neuroglancer/util/http_request';


export const GRAPH_SERVER_NOT_SPECIFIED = Symbol('Graph Server Not Specified.');

let GRAPH_BASE_URL = '';

export function enableGraphServer (url: string) : void {
  GRAPH_BASE_URL = url;
}

export function getRoot (segment: Uint64) : Promise<Uint64> {
  if (!GRAPH_BASE_URL) {
    return Promise.resolve(segment);
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
    return Promise.resolve([segment]);
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
    return Promise.resolve([]);
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
export function mergeNodes (first: Uint64, second: Uint64) : Promise<Uint64> {
  if (!GRAPH_BASE_URL) {
    return Promise.reject(GRAPH_SERVER_NOT_SPECIFIED);
  }

  let promise = sendHttpRequest(openHttpRequest(`${GRAPH_BASE_URL}/1.0/merge/${first},${second}`), 'arraybuffer');
  return promise.then(response => {
    let uint32 = new Uint32Array(response);
    return new Uint64(uint32[0], uint32[1]);
  }).catch((e: HttpError) => {
    console.log(`Could not retrieve merge result of segments ${first} and ${second}.`);
    console.error(e);

    return Promise.reject(e);
  });
}

export function splitObject (first: Uint64, second: Uint64) : Promise<Uint64[]> {
  if (!GRAPH_BASE_URL) {
    return Promise.reject(GRAPH_SERVER_NOT_SPECIFIED);
  }

  let promise = sendHttpRequest(openHttpRequest(`${GRAPH_BASE_URL}/1.0/split/${first},${second}`), 'arraybuffer');
  return promise.then(response => {
    let uint32 = new Uint32Array(response);
    let final : Uint64[] = new Array(uint32.length/2);

    for (let i = 0; i < uint32.length/2; i++) {
      final[i] = new Uint64(uint32[2*i], uint32[2*i+1]);
    }

    return final;
  }).catch((e: HttpError) => {
    console.log(`Could not retrieve split result of segments ${first} and ${second}.`);
    console.error(e);

    return Promise.reject(e);
  });
}

