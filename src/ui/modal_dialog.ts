/**
 * @license
 * Copyright 2024 Google Inc.
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
 *
 * @file UI menu for taking screenshots from the viewer.
 */

import svg_close from "ikonate/icons/close.svg?raw";
import { Overlay } from "#src/overlay.js";
import "#src/ui/modal_dialog.css";
import { makeIcon } from "#src/widget/icon.js";

export class ModalDialog extends Overlay {
  protected closeMenuButton: HTMLButtonElement;
  protected mainBody: HTMLDivElement;

  constructor(private title: string) {
    super();
    this.initializeUI();
  }

  protected createButton(
    text: string | null,
    onClick: () => void,
    cssClass: string = "",
    svgUrl: string | null = null,
  ): HTMLButtonElement {
    const button = document.createElement("button");
    if (svgUrl) {
      const icon = makeIcon({ svg: svgUrl });
      button.appendChild(icon);
    } else if (text) {
      button.textContent = text;
    }
    button.classList.add("neuroglancer-modal-dialog-button");
    if (cssClass) button.classList.add(cssClass);
    button.addEventListener("click", onClick);
    return button;
  }

  initializeUI() {
    this.content.classList.add("neuroglancer-modal-dialog");
    const parentElement = this.content.parentElement;
    if (parentElement) {
      parentElement.classList.add("neuroglancer-modal-dialog-overlay");
    }

    const closeAndHelpContainer = document.createElement("div");
    closeAndHelpContainer.classList.add("neuroglancer-modal-dialog-close");

    const title = document.createElement("h2");
    title.classList.add("neuroglancer-modal-dialog-title");
    title.textContent = this.title;

    this.closeMenuButton = this.createButton(
      null,
      () => this.close(),
      "neuroglancer-modal-dialog-close-button",
      svg_close,
    );

    closeAndHelpContainer.appendChild(title);
    closeAndHelpContainer.appendChild(this.closeMenuButton);

    // This is the header
    this.content.appendChild(closeAndHelpContainer);

    this.mainBody = document.createElement("div");
    this.mainBody.classList.add(
      "neuroglancer-modal-dialog-main-body-container",
    );
    this.content.appendChild(this.mainBody);
  }
}
