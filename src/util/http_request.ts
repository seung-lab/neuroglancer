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

import type { ProgressListener } from "#src/util/progress_listener.js";

export class HttpError extends Error {
  url: string;
  status: number;
  statusText: string;
  response?: Response;

  constructor(
    url: string,
    status: number,
    statusText: string,
    response?: Response,
    options?: { cause: any },
  ) {
    let message = `Fetching ${JSON.stringify(
      url,
    )} resulted in HTTP error ${status}`;
    if (statusText) {
      message += `: ${statusText}`;
    }
    message += ".";
    super(message, options);
    this.name = "HttpError";
    this.message = message;
    this.url = url;
    this.status = status;
    this.statusText = statusText;
    if (response) {
      this.response = response;
    }
  }

  static fromResponse(response: Response) {
    return new HttpError(
      response.url,
      response.status,
      response.statusText,
      response,
    );
  }

  static fromRequestError(input: RequestInfo, error: unknown) {
    if (error instanceof TypeError) {
      let url: string;
      if (typeof input === "string") {
        url = input;
      } else {
        url = input.url;
      }
      return new HttpError(url, 0, "Network or CORS error", undefined, {
        cause: error,
      });
    }
    return error;
  }
}

const maxAttempts = 32;
const minDelayMilliseconds = 500;
const maxDelayMilliseconds = 10000;

export function pickDelay(attemptNumber: number): number {
  // If `attemptNumber == 0`, delay is a random number of milliseconds between
  // `[minDelayMilliseconds, minDelayMilliseconds*2]`.  The lower and upper bounds of the interval
  // double with each successive attempt, up to the limit of
  // `[maxDelayMilliseconds/2,maxDelayMilliseconds]`.
  return (
    Math.min(
      2 ** attemptNumber * minDelayMilliseconds,
      maxDelayMilliseconds / 2,
    ) *
    (1 + Math.random())
  );
}

/**
 * A "stuck" request — a connection that opens but never returns response headers — is aborted after
 * this many milliseconds and re-issued on a fresh connection.  On a clustered storage backend the
 * retry may be routed to a healthy head node ("nudged"), which is the common cause of image chunks
 * that otherwise hang indefinitely.  The value must sit comfortably above the real response latency
 * so that healthy-but-slow requests are not retried needlessly.
 */
export const requestTimeoutMilliseconds = 7000;

/**
 * Maximum number of times a request aborted by {@link requestTimeoutMilliseconds} is re-issued.  The
 * initial attempt is not counted, so a stuck request is attempted at most `maxTimeoutRetries + 1`
 * times before the timeout error propagates.
 */
export const maxTimeoutRetries = 2;

/**
 * Only idempotent reads are re-issued automatically on timeout; retrying a hung POST/PUT/DELETE
 * could apply a side effect twice.
 */
function isIdempotentRequest(init: RequestInit | undefined): boolean {
  const method = (init?.method ?? "GET").toUpperCase();
  return method === "GET" || method === "HEAD";
}

function combineAbortSignals(
  signals: (AbortSignal | null | undefined)[],
): AbortSignal | undefined {
  const present = signals.filter(
    (signal): signal is AbortSignal => signal != null,
  );
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return AbortSignal.any(present);
}

/**
 * Issues a `fetch` request.
 *
 * If the request fails due to an HTTP status outside `[200, 300)`, throws an `HttpError`.  If the
 * request fails due to a network or CORS restriction, throws an `HttpError` with a `status` of `0`.
 *
 * If the request fails due to a transient error (429, 503, 504), retry.
 *
 * Idempotent (GET/HEAD) requests are additionally guarded by a per-attempt timeout: if response
 * headers do not arrive within {@link requestTimeoutMilliseconds}, the in-flight request is aborted
 * and re-issued (up to {@link maxTimeoutRetries} times) on a fresh connection.  The timeout guards
 * only the wait for response headers; once they arrive it is cleared, so a slow body download is
 * never interrupted.  A request cancelled by the caller's `signal` is never retried.
 */
export async function fetchOk(
  input: RequestInfo,
  init?: RequestInitWithProgress,
): Promise<Response> {
  const callerSignal = init?.signal;
  const timeoutEnabled = isIdempotentRequest(init);
  let timeoutRetry = 0;
  for (let requestAttempt = 0; ; ) {
    callerSignal?.throwIfAborted();
    const timeoutController = timeoutEnabled
      ? new AbortController()
      : undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    if (timeoutController !== undefined) {
      timeoutId = setTimeout(() => {
        timeoutController.abort(
          new DOMException("Request timed out", "TimeoutError"),
        );
      }, requestTimeoutMilliseconds);
    }
    let response: Response;
    try {
      response = await fetch(input, {
        ...init,
        signal: combineAbortSignals([callerSignal, timeoutController?.signal]),
      });
    } catch (error) {
      // The caller cancelled the request (e.g. the chunk is no longer needed): never retry.
      callerSignal?.throwIfAborted();
      // Our own per-attempt timeout fired: nudge the storage cluster with a fresh request.
      if (
        timeoutController?.signal.aborted === true &&
        timeoutRetry++ < maxTimeoutRetries
      ) {
        continue;
      }
      throw HttpError.fromRequestError(input, error);
    } finally {
      // Stop guarding once headers have arrived (or the attempt failed) so the response body,
      // which may still be streaming, is not aborted by this attempt's timeout.
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
    if (!response.ok) {
      const { status } = response;
      if (status === 429 || status === 503 || status === 504) {
        // 429: Too Many Requests.  Retry.
        // 503: Service unavailable.  Retry.
        // 504: Gateway timeout.  Can occur if the server takes too long to reply.  Retry.
        if (++requestAttempt !== maxAttempts) {
          await new Promise((resolve) =>
            setTimeout(resolve, pickDelay(requestAttempt - 1)),
          );
          continue;
        }
      }
      throw HttpError.fromResponse(response);
    }
    return response;
  }
}

export interface RequestInitWithProgress extends RequestInit {
  progressListener?: ProgressListener;
}

export type FetchOk = (
  input: RequestInfo,
  init?: RequestInitWithProgress,
) => Promise<Response>;

export function isNotFoundError(e: any) {
  if (!(e instanceof HttpError)) return false;
  // Treat CORS errors (0) or 403 as not found.  S3 returns 403 if the file does not exist because
  // permissions are per-file.
  return e.status === 0 || e.status === 403 || e.status === 404;
}
