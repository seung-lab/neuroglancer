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

import {AUTHENTICATION_GET_SHARED_TOKEN_RPC_ID, AUTHENTICATION_REAUTHENTICATE_RPC_ID, authFetchWithSharedValue, SharedAuthToken, AuthToken} from 'neuroglancer/authentication/base.ts';
import {SharedWatchableValue} from 'neuroglancer/shared_watchable_value.ts';
import {CancellationToken, uncancelableToken} from 'neuroglancer/util/cancellation';
import {ResponseTransform} from 'neuroglancer/util/http_request';
import {registerPromiseRPC, registerRPC, RPC} from 'neuroglancer/worker_rpc';

function openPopupCenter(url: string, width: number, height: number) {
  const top = window.outerHeight - window.innerHeight + window.innerHeight / 2 - height / 2;
  const left = window.innerWidth / 2 - width / 2;
  return window.open(
    url, undefined, `toolbar=no, menubar=no, width=${width}, height=${height}, top=${top}, left=${left}`
  );
}

// generate a token with the neuroglancer-auth service using google oauth2
async function authorize(auth_url: string): Promise<AuthToken> {
  const auth_popup = openPopupCenter(
      `${auth_url}?redirect=${encodeURI(window.location.origin + '/auth_redirect.html')}`, 400, 650);

  const closeAuthPopup = () => {
    if (auth_popup) {
      auth_popup.close();
    }
  }

  window.addEventListener('beforeunload', closeAuthPopup);

  if (!auth_popup) {
    alert('Allow popups on this page to authenticate');
    throw new Error('Allow popups on this page to authenticate');
  }

  return new Promise((f, r) => {
    const checkClosed = setInterval(() => {
      if (auth_popup.closed) {
        clearInterval(checkClosed);
        r(new Error('Auth popup closed'));
      }
    }, 1000);

    const tokenListener = async (ev: MessageEvent) => {
      if (ev.source === auth_popup) {
        clearInterval(checkClosed);
        window.removeEventListener('message', tokenListener);
        window.removeEventListener('beforeunload', closeAuthPopup);
        closeAuthPopup();

        const token: AuthToken = {token: ev.data.token, url: auth_url, apps: []};
        await updateAppUrls(token);
        f(token);
      }
    };

    window.addEventListener('message', tokenListener);
  });
}

let currentReauthentication: Promise<AuthToken>|null = null;

const LOCAL_STORAGE_AUTH_KEY = 'auth_token_v2';

function getAuthTokenFromLocalStorage() {
  const token = localStorage.getItem(LOCAL_STORAGE_AUTH_KEY);
  if (token) {
    return <AuthToken>JSON.parse(token);
  } else {
    return null;
  }
}

function saveAuthTokenToLocalStorage() {
  // grab from authTokenShared so we don't accidently overwrite an older token
  if (authTokenShared && authTokenShared.value) {
    localStorage.setItem(LOCAL_STORAGE_AUTH_KEY, JSON.stringify(authTokenShared.value));
  }
}

async function updateAppUrls(token: AuthToken) {
  const segments = token.url.split('/');
  segments.pop();
  const appListUrl = segments.join('/') + '/app';

  const url = new URL(appListUrl);
  url.searchParams.set('middle_auth_token', token.token);
  const res = await fetch(url.href);
  if (res.status === 200) {
    const apps = (await res.json()).map((x: any) => x.url);
    token.apps = apps;
  } else {
    throw new Error(`status ${res.status}`);
  }
}

// returns the token required to authenticate with "neuroglancer-auth" requiring services
// client currently only supports a single token in use at a time
async function reauthenticate(
    auth_url: string, used_token?: SharedAuthToken): Promise<AuthToken> {
  if (currentReauthentication) {
    return currentReauthentication;
  }

  const storedToken = getAuthTokenFromLocalStorage();

  let usedTokenIsSame = false;

  if (used_token && used_token.value && storedToken) {
    usedTokenIsSame = (used_token.value.token === storedToken.token && used_token.value.url === storedToken.url);
  }

  // if the stored token is not what was tried, and auth url matches, try the stored token
  if (storedToken && storedToken.url === auth_url && !usedTokenIsSame) {
    authTokenShared!.value = storedToken;
    return storedToken;
  } else {
    currentReauthentication = authorize(auth_url);
    const tokenWithUrl = await currentReauthentication;
    currentReauthentication = null;
    authTokenShared!.value = tokenWithUrl;
    saveAuthTokenToLocalStorage();
    return tokenWithUrl;
  }
}

export let authTokenShared: SharedAuthToken|undefined;

export function initAuthTokenSharedValue(rpc: RPC) {
  const token = getAuthTokenFromLocalStorage();

  if (token) {
    updateAppUrls(token).then(() => {
      saveAuthTokenToLocalStorage();
    });
  }

  authTokenShared = SharedWatchableValue.make(rpc, token);
  return authTokenShared;
}

// allow backend thread to access the shared token rpc id so that it can initialize the shared value
registerPromiseRPC<number>(AUTHENTICATION_GET_SHARED_TOKEN_RPC_ID, function() {
  return new Promise((f) => {
    f({value: authTokenShared!.rpcId!});
  });
});

// allow backend to trigger reauthentication when shared value token is invalid
registerRPC(AUTHENTICATION_REAUTHENTICATE_RPC_ID, function({auth_url, used_token}) {
  return reauthenticate(auth_url, used_token).then((token) => {
    return {value: token};
  });
});

export const responseIdentity = async (x: any) => x;

export async function authFetch(input: RequestInfo, init?: RequestInit): Promise<Response>;
export async function authFetch<T>(
    input: RequestInfo, init: RequestInit, transformResponse?: ResponseTransform<T>,
    cancellationToken?: CancellationToken, handleError?: boolean): Promise<T>;
export async function authFetch<T>(
    input: RequestInfo, init: RequestInit = {}, transformResponse?: ResponseTransform<T>,
    cancellationToken: CancellationToken = uncancelableToken,
    handleError = true): Promise<T|Response> {
  const response = await authFetchWithSharedValue(
      reauthenticate, authTokenShared!, input, init, cancellationToken, handleError);

  if (transformResponse) {
    return transformResponse(response);
  } else {
    return response;
  }
}
