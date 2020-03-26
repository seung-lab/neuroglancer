/**
 * @license
 * Copyright 2019 The Neuroglancer Authors
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

import {SharedWatchableValue} from 'neuroglancer/shared_watchable_value';
import {CancellationToken, uncancelableToken} from 'neuroglancer/util/cancellation';
import { HttpError } from 'neuroglancer/util/http_request';

export const AUTHENTICATION_GET_SHARED_TOKEN_RPC_ID = 'Authentication.get_shared_token';
export const AUTHENTICATION_REAUTHENTICATE_RPC_ID = 'Authentication.reauthenticate';

export function parseWWWAuthHeader(headerVal: string) {
  const tuples =
      <[string, string][]>headerVal.split('Bearer ')[1].split(', ').map((x) => x.split('='));
  const wwwAuthMap = new Map<String, string>();

  for (let [key, val] of tuples) {
    wwwAuthMap.set(key, val.replace(/"/g, ''));
  }

  return wwwAuthMap;
}

export type SharedAuthToken = SharedWatchableValue<string|null>;

type ReauthFunction = (auth_url: string, used_token?: string|SharedAuthToken) => Promise<string>;

export class AuthenticationError extends Error {
  realm: string;

  constructor(realm: string) {
    super();
    this.realm = realm;
  }
}

async function authFetchOk(input: RequestInfo, init?: RequestInit): Promise<Response> {
  try {
    const res = await fetch(input, init);

    if (res.status === 400 || res.status === 401) {
      const wwwAuth = res.headers.get('WWW-Authenticate');
      if (wwwAuth) {
        if (wwwAuth.startsWith('Bearer ')) {
          const wwwAuthMap = parseWWWAuthHeader(wwwAuth);

          if (!wwwAuthMap.get('error') || wwwAuthMap.get('error') === 'invalid_token') {
            // missing or expired
            throw new AuthenticationError(<string>wwwAuthMap.get('realm'));
          }
          throw new Error(`status ${res.status} auth error - ${
            wwwAuthMap.get('error')} + " Reason: ${wwwAuthMap.get('error_description')}`);
        }
      }
    }

    if (!res.ok) {
      throw HttpError.fromResponse(res);
    }

    return res;
  } catch (error) {
    // A fetch() promise will reject with a TypeError when a network error is encountered or CORS is misconfigured on the server-side
    if (error instanceof TypeError) {
      throw new HttpError('', 0, '');
    }
    throw error;
  }
}

export async function authFetchWithSharedValue(
    reauthenticate: ReauthFunction, authTokenShared: SharedAuthToken,
    input: RequestInfo, init: RequestInit,
    cancellationToken: CancellationToken = uncancelableToken): Promise<Response> {
  // if (!input) {
  //   return fetch(input);  // to keep the errors consistent
  // }

  // cancellationToken.isCanceled;

  // const unregisterCancellation = 
  // cancellationToken.add(() => {
  //   // console.log('cancel request');
  //   return abortController.abort();
  // });

  // console.log(cancellationToken.isCanceled);

  function setAuthHeader(options: any) {
    options = JSON.parse(JSON.stringify(init));

    // handle aborting
    const abortController = new AbortController();
    options.signal = abortController.signal;
    const abort = () => {
      abortController.abort();
    };
    cancellationToken.add(abort);

    // const authToken = authTokenShared!.value;

    // if (authToken) {
    //   options.headers = options.headers || new Headers();

    //   // Headers object seems to be the correct format but a regular object is supported as well
    //   if (options.headers instanceof Headers) {
    //     options.headers.set('Authorization', `Bearer ${authToken}`);
    //   } else {
    //     options.headers['Authorization'] = `Bearer ${authToken}`;
    //   }
    // }

    return options;
  }

  function setAuthQuery(input: RequestInfo) {
    if (input instanceof Request) {
      // do nothing
    } else {
      const authToken = authTokenShared!.value;

      if (authToken) {
        const url = new URL(input);
        url.searchParams.set('token', authToken);
        return url.href;
      }
    }
    
    return input;
  }
  

  try {
    // console.log('trying authFetchOk', input);
    return await authFetchOk(setAuthQuery(input), setAuthHeader(init));
  } catch (error) {
    console.log('error', error);
    if (error instanceof AuthenticationError) {
      // console.log('reauthenticate started');
      await reauthenticate(error.realm, authTokenShared); // try once after authenticating
      // console.log('reauthenticate done');
      return await authFetchOk(setAuthQuery(input), setAuthHeader(init));
    } else {
      throw error;
    }
  } finally {
    // cancellationToken.remove(abort);
  }
}
