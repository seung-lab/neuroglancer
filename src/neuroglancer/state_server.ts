/**
 * @license
 * Copyright 2017 Thomas Macrina
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

/**
 * Create an object to handle multiple state server attributes.
 *
 * We don't use this, right now. We use a single TrackableValue for only the 
 * url of the state server. If we wanted to pass additional information, we
 * could consider using an object structure like this.
 */

import {RefCounted} from 'neuroglancer/util/disposable';
import {verifyObject, verifyObjectProperty} from 'neuroglancer/util/json';
import {NullarySignal} from 'neuroglancer/util/signal';

export class StateServer extends RefCounted {
  changed = new NullarySignal();
  constructor(public url = '') {
    super();
  }

  reset() {
    this.url = '';
  }

  restoreState(obj: any) {
    try {
      verifyObject(obj);
      verifyObjectProperty(obj, 'url', x => {
        if (x !== undefined) {
          this.url = x;
        }
      });
    } catch {
      this.reset();
    }
    this.changed.dispatch();
  }

  toJSON() {
    let empty = true;
    let obj: any = {};
    if (this.url !== '') {
      empty = false
      obj['url'] = this.url
    }
    if (empty) {
      return undefined;
    }
    return obj;
  }
}
