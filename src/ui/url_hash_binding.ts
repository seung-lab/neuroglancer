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

import { debounce } from "lodash-es";
import type { CredentialsManager } from "#src/credentials_provider/index.js";
import { StatusMessage } from "#src/status.js";
import { WatchableValue } from "#src/trackable_value.js";
import { RefCounted } from "#src/util/disposable.js";
import { responseJson } from "#src/util/http_request.js";
import { urlSafeParse, verifyObject } from "#src/util/json.js";
import {
  cancellableFetchSpecialOk,
  parseSpecialUrl,
} from "#src/util/special_protocol_request.js";
import type { Trackable } from "#src/util/trackable.js";
import { getCachedJson } from "#src/util/trackable.js";

/**
 * @file Implements a binding between a Trackable value and the URL hash state.
 */

/**
 * Encodes a fragment string robustly.
 */
function encodeFragment(fragment: string) {
  return encodeURI(fragment).replace(
    /[!'()*;,]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

export interface UrlHashBindingOptions {
  defaultFragment?: string;
  updateDelayMilliseconds?: number;
}

/**
 * An instance of this class manages a binding between a Trackable value and the URL hash state.
 * The binding is initialized in the constructor, and is removed when dispose is called.
 */
export class UrlHashBinding extends RefCounted {
  /**
   * Most recently parsed or set state string.
   */
  private prevStateString: string | undefined;

  /**
   * Generation number of previous state set.
   */
  private prevStateGeneration: number | undefined;

  /**
   * Most recent error parsing URL hash.
   */
  parseError = new WatchableValue<Error | undefined>(undefined);

  private defaultFragment: string;

  sessionId = self.crypto.randomUUID();

  historyIndex = 0;
  
  startTime = Date.now();
  resetSessionId() {
    this.sessionId = self.crypto.randomUUID();
  }
  resetHistoryIndex() {
    this.historyIndex = 0;
  }
  
  private _recording: boolean;

  get recording(): boolean {
    return this._recording;
  }

  set recording(isRecording: boolean) {
    this._recording = isRecording;
    localStorage.setItem("recording", isRecording.toString());
  }

  constructor(
    public root: Trackable,
    public credentialsManager: CredentialsManager,
    options: UrlHashBindingOptions = {},
  ) {
    super();

    /**
      * In the constructor (called upon refresh), we verify existence of recording state and get it back if possible
      */
    const storedRecording = localStorage.getItem("recording");
    this._recording = storedRecording !== null ? storedRecording === "true" : false;
    let isDragging = false; 
    let clickTimeout: number | null = null; 
    let isSingleClick = true;


    const activeKeys = new Set<string>();

    const trackKeyDown = (event: KeyboardEvent) => {
      activeKeys.add(event.key);
    };

    const trackKeyUp = (event: KeyboardEvent) => {
      activeKeys.delete(event.key);
    };

    const mouseEventListener = (event: MouseEvent, clickTarget: string = '') => {

      const handleClick = (eventType: string) => {
        let buttonType: string;
        const keysPressed = Array.from(activeKeys).join(", ") || "None";

        if (event.button === 0) {
          buttonType = "Left Click";
        } else if (event.button === 1) {
          buttonType = "Middle Click";
        } else if (event.button === 2) {
          buttonType = "Right Click";
        } else {
          buttonType = "Unknown Button";
        }
    
        if (clickTarget !== '') {
          // means we clicked on important parts
          //console.log(`Inside render: ${eventType}: ${buttonType} | ${clickTarget} with keys: ${keysPressed} `);
          throttledSetUrlHash(`Inside render: ${eventType}: ${buttonType} | ${clickTarget} with keys: ${keysPressed} `);
        }
        else {
          //console.log('Don\'t care where you clicked, JSON will catch it if it was important');
          throttledSetUrlHash(
            `Outside render: ${eventType}: ${buttonType} with keys: ${keysPressed}`
        );
      }
      };
      if (event.button === 1) {
        handleClick("Single Click");
      } else if (event.button === 2) {
        handleClick("Single Click");
      } 
      else if (event.button === 0) {
        // logic for double click detection
        if (clickTimeout) {
          //console.log("Received second click in window of time");
          clearTimeout(clickTimeout);
          clickTimeout = null;
          isSingleClick = false; 
          handleClick("Double Click");
        } else {
          isSingleClick = true;
          clickTimeout = window.setTimeout(() => {
            clickTimeout = null;
            if (isSingleClick) {
              handleClick("Single Click");
            }
          }, 200); // in ms, time to detect double click
          }
        }
      else {
        console.log("Unknown mouse button clicked");
      }
      };
    
    
    const mouseDownHandler = (event: MouseEvent) => {

      if (event.button === 0) {  // Only track left mouse button
        isDragging = true;
        // prevClientX = event.clientX;
        // prevClientY = event.clientY;
        const mouseMoveHandler = () => {
          if (!isDragging) {
            return;
          }
          //console.log("Drag event triggered");
          // const deltaX = e.clientX - prevClientX;
          // const deltaY = e.clientY - prevClientY;
          // prevClientX = e.clientX;
          // prevClientY = e.clientY;
          // Triggers the throttled hash update during dragging, 
          // Careful throttled dragging is too slow to actually be able to rebuild
          // the state correctly (+ R3 rotations are a non abelian group, meaning we can't just take the cumulated values of dragging)
          // -> current hack is to record the state through the JSON instead of the deltas X and Y of the mouse
          throttledSetUrlHash(`Drag`);
        };

        const mouseUpHandler = (e: PointerEvent) => {
          if (e.button === event.button) {
            // End dragging when mouse button is released
            isDragging = false;
            //console.log("Drag ended");
            window.removeEventListener("pointermove", mouseMoveHandler);
            window.removeEventListener("pointerup", mouseUpHandler);
          }
        };
        // Add event listeners to track mouse movement and stop when mouse button is released
        window.addEventListener("pointermove", mouseMoveHandler, true);
        window.addEventListener("pointerup", mouseUpHandler, true);
      }
    };

    const wheelHandler = () => {
      // const deltaX = event.deltaX;
      // const deltaY = event.deltaY;
      // const deltaZ = event.deltaZ;
      throttledSetUrlHash(`Wheel`);
    };

    this.registerEventListener(window, "wheel", () => {
      // console.log("Event listener got a wheel event triggered");
      wheelHandler();
    }, true);

    const keyboardEventListener = (event: KeyboardEvent) => {
      //console.log("Key is pressed: ", event.key);
      throttledSetUrlHash(`Keyboard: ${event.type}`);
    };
    
    this.registerEventListener(window, "dblclick", (event: MouseEvent) => {
      // this function doesn't work very well as double click is often seen as just two simple clicks
      // console.log("Double click event triggered");
      mouseEventListener(event);
    });
    
    this.registerEventListener(window, "mousedown", (event: MouseEvent) => {
      // this corresponds to dragging events
      //console.log("Mouse down event triggered");
      mouseDownHandler(event);
    }, true);
    
    this.registerEventListener(window, "mouseup", (event: MouseEvent) => {
      const clickedElement =event.target;
      let clickTarget = "";
      //console.log("Mouse up event triggered", clickedElement);
      if (clickedElement instanceof HTMLElement) {
        //console.log("Exact element clicked:", clickedElement);
        //console.log("Tag name:", clickedElement.tagName);
        //console.log("Class list:", clickedElement.className);
        //.log("ID:", clickedElement.id);

        const parent = clickedElement.closest('.neuroglancer-layer-group-viewer');
        if (parent) {
          const rect = parent.getBoundingClientRect();
          const relativeX = event.clientX - rect.left;
          const relativeY = event.clientY - rect.top;
          clickTarget = `Relative position: x=${relativeX}, y=${relativeY}`;
          //console.log("Clicked inside layer group viewer");
        }
        else {
          //console.log('Clicked on something else');
          clickTarget = '';
        }
      mouseEventListener(event, clickTarget);  
      }
    }, true);


    this.registerEventListener(window, "keydown", (event: KeyboardEvent) => {
      trackKeyDown(event);
      keyboardEventListener(event);
    });

    this.registerEventListener(window, "keyup", (event: KeyboardEvent) => {
      trackKeyUp(event);
      keyboardEventListener(event);
    });
    
    const { updateDelayMilliseconds = 50, defaultFragment = "{}" } = options;

    this.registerEventListener(window, "hashchange", () => {
      this.updateFromUrlHash();
    });
    window.addEventListener("blur", () => {
      activeKeys.clear(); // Clear active keys when focus is lost, like clicking developer tools f.e.
    });

    const throttledSetUrlHash = debounce(
      (action_name: string) => {
        this.setUrlHash(action_name);
      },
      updateDelayMilliseconds,
      { maxWait: updateDelayMilliseconds }
    );
    // this.registerDisposer(root.changed.add(throttledSetUrlHash)); // Original line that triggers state update upon change, however we need associated user actions.
    this.registerDisposer(() => throttledSetUrlHash.cancel());
    this.defaultFragment = defaultFragment;

    // this.registerDisposer(
    //   root.changed.add(() => {
    //     this.setUrlHash(true);
    //   }),
    // );
  }

  /**
   * Sets the URL hash to match the current state.
   */
  
  setUrlHash(action_name= "user_action", saveOnly = false) {
    const cacheState = getCachedJson(this.root)
    const { generation } = cacheState;
    if (generation !== this.prevStateGeneration) {
      this.prevStateGeneration = cacheState.generation;
      const jsonString = JSON.stringify(cacheState.value);
      const stateString = encodeFragment(jsonString);
      if (stateString !== this.prevStateString) {
        this.prevStateString = stateString;
        if (!saveOnly) {
          if (decodeURIComponent(stateString) === "{}") {
            history.replaceState(null, "", "#");
          } else {
            history.replaceState(null, "", "#!" + stateString);
          }
        }
        if (this.recording) {
          console.log("recording", this.sessionId, this.historyIndex, "Action Event: " + action_name);
          // not directly useful, technically can be obtained with history_time
          // localStorage.setItem(
          //   `history_elapsed_${this.sessionId}_${this.historyIndex}`,
          //   (Date.now() - this.startTime).toString(),
          // );
          localStorage.setItem(
            `history_time_${this.sessionId}_${this.historyIndex}`,
            Date.now().toString(),
          );
          localStorage.setItem(
            `history_state_${this.sessionId}_${this.historyIndex}`,
            jsonString,
          );
          //console.log("history_state", jsonString);
          localStorage.setItem(
            `history_action_${this.sessionId}_${this.historyIndex}`,
            "Action Event: " + action_name,
          );
          this.historyIndex++;
        }
      }
    }
  }

  /**
   * Sets the current state to match the URL hash.  If it is desired to initialize the state based
   * on the URL hash, then this should be called immediately after construction.
   */
  updateFromUrlHash(upgradeState: (a: any) => any = (x) => x) {
    console.log("updateFromUrlHash called");
    try {
      let s = location.href.replace(/^[^#]+/, "");
      if (s === "" || s === "#" || s === "#!") {
        s = "#!" + this.defaultFragment;
      }
      // Handle remote JSON state
      if (s.match(/^#!([a-z][a-z\d+-.]*):\/\//)) {
        const url = s.substring(2);
        const { url: parsedUrl, credentialsProvider } = parseSpecialUrl(
          url,
          this.credentialsManager,
        );
        StatusMessage.forPromise(
          cancellableFetchSpecialOk(
            credentialsProvider,
            parsedUrl,
            {},
            responseJson,
          ).then((json) => {
            verifyObject(json);
            this.root.reset();
            this.root.restoreState(json);
          }),
          {
            initialMessage: `Loading state from ${url}`,
            errorPrefix: "Error loading state:",
          },
        );
      } else if (s.startsWith("#!+")) {
        s = s.slice(3);
        // Firefox always %-encodes the URL even if it is not typed that way.
        s = decodeURIComponent(s);
        const state = urlSafeParse(s);
        verifyObject(state);
        this.root.restoreState(state);
        this.prevStateString = undefined;
      } else if (s.startsWith("#!")) {
        s = s.slice(2);
        s = decodeURIComponent(s);
        if (s === this.prevStateString) {
          return;
        }
        this.prevStateString = s;
        this.root.reset();
        const state = urlSafeParse(s);
        verifyObject(state);
        upgradeState;
        this.root.restoreState(upgradeState(state));
      } else {
        throw new Error(
          `URL hash is expected to be of the form "#!{...}" or "#!+{...}".`,
        );
      }
      this.parseError.value = undefined;
    } catch (parseError) {
      this.parseError.value = parseError;
    }
  }
}
