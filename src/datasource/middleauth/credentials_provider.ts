/**
 * @license
 * Copyright 2020 Google Inc.
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

import type {
  CredentialsManager,
  CredentialsWithGeneration,
} from "#src/credentials_provider/index.js";
import {
  CredentialsProvider,
  makeCredentialsGetter,
} from "#src/credentials_provider/index.js";
import type { OAuth2Credentials } from "#src/credentials_provider/oauth2.js";
import { StatusMessage } from "#src/status.js";
import type { CancellationToken } from "#src/util/cancellation.js";
import {
  verifyObject,
  verifyObjectProperty,
  verifyString,
  verifyStringArray,
} from "#src/util/json.js";
import { Signal } from "#src/util/signal.js";
import type { HttpError } from "src/util/http_request";

export type MiddleAuthToken = {
  tokenType: string;
  accessToken: string;
  url: string;
  appUrls: string[];
};

function openPopupCenter(url: string, width: number, height: number) {
  const top =
    window.outerHeight -
    window.innerHeight +
    window.innerHeight / 2 -
    height / 2;
  const left = window.innerWidth / 2 - width / 2;
  return window.open(
    url,
    undefined,
    `toolbar=no, menubar=no, width=${width}, height=${height}, top=${top}, left=${left}`,
  );
}

async function waitForRemoteFlow(
  url: string,
  startMessage: string,
  startAction: string,
  retryMessage: string,
  closedMessage: string,
): Promise<any> {
  const status = new StatusMessage(/*delay=*/ false, /*modal=*/ true);
  const res: Promise<MiddleAuthToken> = new Promise((f) => {
    function writeStatus(message: string, buttonMessage: string) {
      status.element.textContent = message + " ";
      const button = document.createElement("button");
      button.textContent = buttonMessage;
      status.element.appendChild(button);

      button.addEventListener("click", () => {
        writeStatus(retryMessage, "Retry");
        const popup = openPopupCenter(url, 400, 650);
        const closePopup = () => {
          popup?.close();
        };
        window.addEventListener("beforeunload", closePopup);
        const checkClosed = setInterval(() => {
          if (popup?.closed) {
            clearInterval(checkClosed);
            writeStatus(closedMessage, "Retry");
          }
        }, 1000);

        const messageListener = async (ev: MessageEvent) => {
          if (ev.source === popup) {
            clearInterval(checkClosed);
            window.removeEventListener("message", messageListener);
            window.removeEventListener("beforeunload", closePopup);
            closePopup();
            f(ev.data);
          }
        };
        window.addEventListener("message", messageListener);
      });
    }
    writeStatus(startMessage, startAction);
  });
  try {
    return await res;
  } finally {
    status.dispose();
  }
}

async function waitForLogin(serverUrl: string): Promise<MiddleAuthToken> {
  const data = await waitForRemoteFlow(
    `${serverUrl}/api/v1/authorize`,
    `middleauth server ${serverUrl} login required.`,
    "Login",
    `Waiting for login to middleauth server ${serverUrl}...`,
    `Login window closed for middleauth server ${serverUrl}.`,
  );
  verifyObject(data);
  const accessToken = verifyObjectProperty(data, "token", verifyString);
  const appUrls = verifyObjectProperty(data, "app_urls", verifyStringArray);
  const token: MiddleAuthToken = {
    tokenType: "Bearer",
    accessToken,
    url: serverUrl,
    appUrls,
  };
  return token;
}

async function showTosForm(url: string, tosName: string) {
  const data = await waitForRemoteFlow(
    url,
    `Before you can access ${tosName}, you need to accept its Terms of Service.`,
    "Open",
    "Waiting for Terms of Service agreement...",
    `Terms of Service closed for ${tosName}.`,
  );
  return data === "success";
}

const LOCAL_STORAGE_AUTH_KEY = "auth_token_v2";

function getAuthTokenFromLocalStorage(authURL: string) {
  const token = localStorage.getItem(`${LOCAL_STORAGE_AUTH_KEY}_${authURL}`);
  if (token) {
    return <MiddleAuthToken>JSON.parse(token);
  }
  return null;
}

function saveAuthTokenToLocalStorage(authURL: string, value: MiddleAuthToken) {
  localStorage.setItem(
    `${LOCAL_STORAGE_AUTH_KEY}_${authURL}`,
    JSON.stringify(value),
  );
}

const middleAuthLoginEvent = new Event("middleauthlogin");

export class MiddleAuthCredentialsProvider extends CredentialsProvider<MiddleAuthToken> {
  updated = new Signal();

  constructor(private serverUrl: string) {
    super();
  }

  private cachedGet = this.updateCachedGet();

  updateCachedGet() {
    let alreadyTriedLocalStorage = false;
    const res = makeCredentialsGetter(async () => {
      let token = undefined;

      if (!alreadyTriedLocalStorage) {
        alreadyTriedLocalStorage = true;
        token = getAuthTokenFromLocalStorage(this.serverUrl);
      }

      if (!token) {
        console.log("requesting login");
        token = await waitForLogin(this.serverUrl);
        saveAuthTokenToLocalStorage(this.serverUrl, token);
        window.dispatchEvent(middleAuthLoginEvent);
      }

      return token;
    });
    this.cachedGet = res;
    this.updated.dispatch();
    return res;
  }

  get = (
    invalidCredentials?: CredentialsWithGeneration<MiddleAuthToken> | undefined,
    cancellationToken?: CancellationToken | undefined,
  ) => {
    return this.cachedGet(invalidCredentials, cancellationToken);
  };
}

export class UnverifiedApp extends Error {
  url: string;

  constructor(url: string) {
    super();
    this.url = url;
  }
}

export class MiddleAuthAppCredentialsProvider extends CredentialsProvider<MiddleAuthToken> {
  private credentials: CredentialsWithGeneration<MiddleAuthToken> | undefined =
    undefined;
  agreedToTos = false;

  constructor(
    private serverUrl: string,
    private credentialsManager: CredentialsManager,
  ) {
    super();
  }

  private cachedGet = this.updateCachedGet();

  updateCachedGet() {
    const res = makeCredentialsGetter(async () => {
      if (this.credentials && this.agreedToTos) {
        return this.credentials.credentials;
      }
      this.agreedToTos = false;
      const authInfo = await fetch(`${this.serverUrl}/auth_info`).then((res) =>
        res.json(),
      );
      const provider = this.credentialsManager.getCredentialsProvider(
        "middleauth",
        authInfo.login_url,
      ) as MiddleAuthCredentialsProvider;
      // TODO, so is it always expected that MiddleAuthCredentialsProvider
      // will be the open to have updateCachedGetcalled initially?
      const removeHandler = this.registerDisposer(
        provider.updated.add(() => {
          removeHandler();
          this.updateCachedGet();
        }),
      );
      this.credentials = await provider.get(this.credentials);
      if (this.credentials.credentials.appUrls.includes(this.serverUrl)) {
        return this.credentials.credentials;
      } else {
        const status = new StatusMessage(/*delay=*/ false);
        status.setText(`middleauth: unverified app ${this.serverUrl}`);
        throw new UnverifiedApp(this.serverUrl);
      }
    });
    this.cachedGet = res;
    return res;
  }

  get = (
    invalidCredentials?: CredentialsWithGeneration<MiddleAuthToken> | undefined,
    cancellationToken?: CancellationToken | undefined,
  ) => {
    return this.cachedGet(invalidCredentials, cancellationToken);
  };

  errorHandler = async (
    error: HttpError,
    credentials: OAuth2Credentials,
  ): Promise<"refresh"> => {
    const { status } = error;
    if (status === 401) {
      // 401: Authorization needed.  OAuth2 token may have expired.
      return "refresh";
    }
    if (status === 403) {
      const { response } = error;
      if (response) {
        const { headers } = response;
        const contentType = headers.get("content-type");
        if (contentType === "application/json") {
          const json = await response.json();
          if (json.error && json.error === "missing_tos") {
            // Missing terms of service agreement.  Prompt user.
            const url = new URL(json.data.tos_form_url);
            url.searchParams.set("client", "ng");
            const success = await showTosForm(
              url.toString(),
              json.data.tos_name,
            );
            if (success) {
              this.agreedToTos = true;
              return "refresh";
            }
          }
        }
      }
      if (!credentials.accessToken) {
        // Anonymous access denied.  Request credentials.
        return "refresh";
      }
    }
    throw error;
  };
}
