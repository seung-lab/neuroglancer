/**
 * @license
 * Copyright 2016 Google Inc.
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

import {getToken, Token} from 'neuroglancer/datasource/brainmaps/api_implementation';
import {HttpError, openShardedHttpRequest} from 'neuroglancer/util/http_request';
import {CancellablePromise, makeCancellablePromise} from 'neuroglancer/util/promise';

export var numPendingRequests = 0;

export type BrainmapsInstance = number;
export const PRODUCTION_INSTANCE = 0;

export const INSTANCE_NAMES: string[] = [];

/**
 * Maps a BrainmapsInstance to the list of base URL shards to use for accessing it.
 */
export const INSTANCE_BASE_URLS: string[][] = [];
const instanceHostname: string[] = [];

export const INSTANCE_IDENTIFIERS: string[] = [];

export function brainmapsInstanceKey(instance: BrainmapsInstance) {
  return INSTANCE_IDENTIFIERS[instance];
}

export function setupBrainmapsInstance(
    instance: BrainmapsInstance, hostname: string, identifier: string, name: string) {
  INSTANCE_IDENTIFIERS[instance] = identifier;
  INSTANCE_NAMES[instance] = name;
  instanceHostname[instance] = hostname;
  let baseUrls = [`https://${hostname}`];
  INSTANCE_BASE_URLS[instance] = baseUrls;
}

setupBrainmapsInstance(PRODUCTION_INSTANCE, 'brainmaps.googleapis.com', 'prod', 'Brain Maps');

export function makeRequest(
    instance: BrainmapsInstance, method: string, path: string,
    responseType: 'arraybuffer'): CancellablePromise<ArrayBuffer>;
export function makeRequest(
    instance: BrainmapsInstance, method: string, path: string,
    responseType: 'json'): CancellablePromise<any>;
export function makeRequest(
    instance: BrainmapsInstance, method: string, path: string, responseType: string): any;

export function makeRequest(
    instance: BrainmapsInstance, method: string, path: string, responseType: string): any {
  /**
   * undefined means request not yet attempted.  null means request
   * cancelled.
   */
  let xhr: XMLHttpRequest|undefined|null = undefined;
  return makeCancellablePromise<any>((resolve, reject, onCancel) => {
    function start(token: Token) {
      if (xhr === null) {
        --numPendingRequests;
        return;
      }
      xhr = openShardedHttpRequest(INSTANCE_BASE_URLS[instance], path, method);
      xhr.responseType = <XMLHttpRequestResponseType>responseType;
      xhr.setRequestHeader('Authorization', `${token['tokenType']} ${token['accessToken']}`);
      xhr.onloadend = function(this: XMLHttpRequest) {
        if (xhr === null) {
          --numPendingRequests;
          return;
        }
        let status = this.status;
        if (status >= 200 && status < 300) {
          --numPendingRequests;
          resolve(this.response);
        } else if (status === 403 || status === 401) {
          // Authorization needed.
          getToken(token).then(start);
        } else {
          --numPendingRequests;
          reject(HttpError.fromXhr(this));
        }
      };
      xhr.send();
    }
    onCancel(() => {
      let origXhr = xhr;
      xhr = null;
      if (origXhr != null) {
        origXhr.abort();
      }
    });
    getToken().then(start);
  });
}
