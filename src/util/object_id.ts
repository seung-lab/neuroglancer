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

const OBJECT_ID_SYMBOL = Symbol("objectId");
let nextObjectId = 0;

/**
 * Returns a string that uniquely identifies a particular primitive value or object instance.
 */
export function getObjectId(x: any) {
  if (x instanceof Object) {
    // Use own-property check so subclasses get distinct ids. A bare
    // `x[OBJECT_ID_SYMBOL]` walks the prototype chain — for a class B that
    // extends A, B would inherit A's id and collide in shader memoize keys.
    let id = Object.prototype.hasOwnProperty.call(x, OBJECT_ID_SYMBOL)
      ? x[OBJECT_ID_SYMBOL]
      : undefined;
    if (id === undefined) {
      id = x[OBJECT_ID_SYMBOL] = nextObjectId++;
    }
    return `o${id}`;
  }
  return "" + JSON.stringify(x);
}
