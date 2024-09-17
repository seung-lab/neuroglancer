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

export function removeChildren(element: HTMLElement) {
  while (true) {
    const child = element.firstChild;
    if (!child) {
      break;
    }
    element.removeChild(child);
  }
}

export function removeFromParent(element: HTMLElement) {
  const { parentElement } = element;
  if (parentElement) {
    parentElement.removeChild(element);
    return true;
  }
  return false;
}

export function updateInputFieldWidth(
  element: HTMLInputElement,
  length = Math.max(1, element.value.length),
) {
  const newWidth = `${length}ch`;
  if (element.style.width !== newWidth) {
    // Force additional reflow to work around Chrome bug.
    element.style.width = "0px";
    element.offsetWidth;
    element.style.width = newWidth;
  }
}

export function updateChildren(
  element: HTMLElement,
  children: Iterable<HTMLElement>,
) {
  console.log("element", element);
  let nextChild = element.firstElementChild;
  for (const child of children) {
    console.log("child", child);
    if (child !== nextChild) {
      element.insertBefore(child, nextChild);
    }
    nextChild = child.nextElementSibling;
  }
  while (nextChild !== null) {
    const next = nextChild.nextElementSibling;
    element.removeChild(nextChild);
    nextChild = next;
  }
}

export function isInputTextTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target.isContentEditable
  ) {
    return true;
  }
  return false;
}

export function measureElementClone(element: HTMLElement) {
  const clone = element.cloneNode(/*deep=*/ true) as HTMLElement;
  clone.style.position = "absolute";
  document.body.appendChild(clone);
  return clone.getBoundingClientRect();
}

export function getBoundingClientRectSupportingDisplayContents(
  element: Element,
) {
  const bounds = element.getBoundingClientRect();
  if (
    bounds.width === 0 &&
    bounds.height === 0 &&
    getComputedStyle(element).display === "contents"
  ) {
    for (const child of element.children) {
      const childRect = getBoundingClientRectSupportingDisplayContents(child);
      bounds.x = Math.min(bounds.x, childRect.x);
      bounds.y = Math.min(bounds.y, childRect.y);
      bounds.width = Math.max(bounds.width, childRect.right - bounds.x);
      bounds.height = Math.max(bounds.height, childRect.bottom - bounds.y);
    }
  }
  return bounds;
}
