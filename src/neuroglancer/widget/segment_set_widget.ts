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

import {SegmentationDisplayState} from 'neuroglancer/segmentation_display_state/frontend';
import {RefCounted} from 'neuroglancer/util/disposable';
import {Uint64} from 'neuroglancer/util/uint64';

require('neuroglancer/noselect.css');
require('./segment_set_widget.css');

type ItemElement = HTMLDivElement;

const temp = new Uint64();

export class SegmentSetWidget extends RefCounted {
  element = document.createElement('div');
  private clearButton = document.createElement('button');
  private itemContainer = document.createElement('div');
  private enabledItems = new Map<string, ItemElement>();
  private disabledItems = new Map<string, ItemElement>();
  
  // disabledItems is a map to store the elements related to hidden segments.
  // The following describes the relationship between a segment ID's existence in either
  // of the above maps with its appearance in neuroglancer and its button in the widget:
  // At any point, if a segment ID is in the enabledItems map, then it is in the widget
  // and displayed in neuroglancer. If it is only in the disabledItems map, then it is only
  // in the widget. If it is in neither, then it neither appears in neuroglancer nor in the widget.

  get rootSegments() {
    return this.displayState.rootSegments;
  }
  get hiddenRootSegments() {
    return this.displayState.hiddenRootSegments;
  }
  get segmentColorHash() {
    return this.displayState.segmentColorHash;
  }
  get segmentSelectionState() {
    return this.displayState.segmentSelectionState;
  }

  constructor(public displayState: SegmentationDisplayState) {
    super();
    const {element, clearButton, itemContainer} = this;
    element.className = 'segment-set-widget neuroglancer-noselect';
    clearButton.className = 'clear-button';
    clearButton.title = 'Remove all segment IDs';
    this.registerEventListener(clearButton, 'click', () => {
      this.rootSegments.clear();
      this.hiddenRootSegments!.clear();
    });

    itemContainer.className = 'item-container';
    element.appendChild(itemContainer);

    itemContainer.appendChild(clearButton);

    this.registerDisposer(displayState.rootSegments.changed.add((x, add) => {
      this.handleSetChanged(x, add, true);
    }));
    this.registerDisposer(displayState.hiddenRootSegments!.changed.add((x, add) => {
      this.handleSetChanged(x, add, false);
    }));
    this.registerDisposer(displayState.segmentColorHash.changed.add(() => {
      this.handleColorChanged();
    }));

    for (let x of displayState.rootSegments) {
      this.addElement(x.toString());
    }
    this.updateClearButtonVisibility();
  }

  private anyRootSegments = () => {
    return this.displayState.rootSegments.size > 0;
  }

  private anyHiddenRootSegments = () => {
    return this.displayState.hiddenRootSegments!.size > 0;
  }

  private updateClearButtonVisibility() {
    const {clearButton} = this;
    clearButton.style.display = (this.anyRootSegments() || this.anyHiddenRootSegments()) ? '' : 'none';
  }

  private clearItems() {
    const {itemContainer, clearButton, enabledItems, disabledItems} = this;
    while (true) {
      const lastElement = itemContainer.lastElementChild!;
      if (lastElement === clearButton) {
        break;
      }
      itemContainer.removeChild(lastElement);
    }
    enabledItems.clear();
    disabledItems.clear();
  }

  // The logic in handling each the displayed and the hidden segment set's changing is very similar,
  // so we can combine the actions into one function.
  private handleSetChanged(x: Uint64|Uint64[]|null, added: boolean, enabledSetChanged: boolean) {
    const {enabledItems, disabledItems, anyRootSegments, anyHiddenRootSegments} = this;
    const {itemMapToChange, otherItemMap, anySegmentsInUnchangedSet} = (enabledSetChanged) ?
      {
        itemMapToChange: enabledItems,
        otherItemMap: disabledItems,
        anySegmentsInUnchangedSet: anyHiddenRootSegments
      } : {
        itemMapToChange : disabledItems,
        otherItemMap: enabledItems,
        anySegmentsInUnchangedSet: anyRootSegments
      };

    if (x === null) {
      // Make sure there aren't any items in other map before clearing
      if (! anySegmentsInUnchangedSet()) {
        // Cleared.
        this.clearItems();
      }
    } else if (added) {
      for (const v of Array<Uint64>().concat(x)) {
        const s = v.toString();
        const itemInOtherMap = otherItemMap.get(s);
        // Make sure item not already added
        if (! itemInOtherMap && enabledSetChanged) {
          this.addElement(s);
        }
        else if (! itemInOtherMap) {
          // Should never happen
          throw new Error('Erroneous attempt to hide a segment ID that does not exist in the widget');
        }
        else {
          // Preparing to enable or disable an element
          itemMapToChange.set(s, itemInOtherMap);
          if (enabledSetChanged) {
            // Do this just in case root segment was enabled by clicking in neuroglancer as opposed to button
            this.setItemsToggleButtonToHideSegment(itemInOtherMap, s);
          }
        }
      }
    } else {
      for (const v of Array<Uint64>().concat(x)) {
        const s = v.toString();
        // Make sure item has been deleted, instead of enabled or disabled
        if (! otherItemMap.get(s)) {
          let itemElement = itemMapToChange.get(s)!;
          itemElement.parentElement!.removeChild(itemElement);
        }
        itemMapToChange.delete(s);
      }
    }
  }

  private addElement(s: string) {
    // Wrap buttons in div so node button and its hide button appear on same line
    const itemElement = document.createElement('div');
    itemElement.className = 'segment-div';
    const itemButton = document.createElement('button');
    itemButton.className = 'segment-button';
    itemButton.textContent = s;
    itemButton.title = `Remove segment ID ${s}`;
    const widget = this;
    itemButton.addEventListener('click', function(this: HTMLButtonElement) {
      temp.tryParseString(this.textContent!);
      widget.rootSegments.delete(temp);
      widget.hiddenRootSegments!.delete(temp);
    });
    itemButton.addEventListener('mouseenter', function(this: HTMLButtonElement) {
      temp.tryParseString(this.textContent!);
      widget.segmentSelectionState.set(temp);
    });
    itemButton.addEventListener('mouseleave', function(this: HTMLButtonElement) {
      temp.tryParseString(this.textContent!);
      widget.segmentSelectionState.set(null);
    });
    const itemToggleButton = document.createElement('button');
    itemToggleButton.className = 'segment-toggle-button';
    widget.setToggleButtonToHideSegment(itemToggleButton, s);
    itemToggleButton.addEventListener('click', function(this: HTMLButtonElement) {
      temp.tryParseString(s);
      if (widget.enabledItems.get(s)) {
        // Add before delete so item is in at least one set
        widget.hiddenRootSegments!.add(temp);
        widget.rootSegments.delete(temp);
        this.textContent = 'Show segment';
        this.title = `Show segment ID ${s}`;
      }
      else {
        // Add before delete again
        widget.rootSegments.add(temp);
        widget.hiddenRootSegments!.delete(temp);
        widget.setToggleButtonToHideSegment(this, s);
      }
    });
    // Button for the user to copy a segment's ID
    const itemCopyIDButton = document.createElement('button');
    itemCopyIDButton.className = 'segment-copy-button';
    itemCopyIDButton.title = `Copy segment ID ${s}`;
    itemCopyIDButton.textContent = 'Copy ID';
    itemCopyIDButton.addEventListener('click', function(this: HTMLButtonElement) {
      const handleCopy = (e: ClipboardEvent) => {
        e.clipboardData.setData('text/plain', s);
        e.preventDefault();
        document.removeEventListener('copy', handleCopy);
        this.style.backgroundColor = 'rgb(0, 255, 0)';
        setTimeout(() => {
          if (this.style.backgroundColor === 'rgb(0, 255, 0)') {
            this.style.backgroundColor = 'rgb(240, 240, 240)';
          }
        }, 300);
      }
      document.addEventListener('copy', handleCopy);
      document.execCommand('copy');
    });
    itemElement.appendChild(itemButton);
    itemElement.appendChild(itemToggleButton);
    itemElement.appendChild(itemCopyIDButton);
    this.setItemButtonColor(itemElement);
    this.itemContainer.appendChild(itemElement);
    this.enabledItems.set(s, itemElement);
  }

  private setItemButtonColor(itemElement: ItemElement) {
    const itemButton =  <HTMLElement>(itemElement.getElementsByClassName('segment-button')[0]);
    temp.tryParseString(itemButton.textContent!);
    itemButton.style.backgroundColor = this.segmentColorHash.computeCssColor(temp);
  }

  private handleColorChanged() {
    this.enabledItems.forEach(itemElement => {
      this.setItemButtonColor(itemElement);
    });
  }

  private setItemsToggleButtonToHideSegment(itemElement: ItemElement, segmentIDString: string) {
    const itemToggleButton =  <HTMLButtonElement>(itemElement.getElementsByClassName('segment-toggle-button')[0]);
    this.setToggleButtonToHideSegment(itemToggleButton, segmentIDString);
  }

  // Made this function just to avoid doing this in several different places
  private setToggleButtonToHideSegment(itemToggleButton: HTMLButtonElement, segmentIDString: string) {
    itemToggleButton.textContent = 'Hide segment';
    itemToggleButton.title = `Hide segment ID ${segmentIDString}`;
  }

  disposed() {
    const {element} = this;
    const {parentElement} = element;
    if (parentElement) {
      parentElement.removeChild(element);
    }
    super.disposed();
  }
}
