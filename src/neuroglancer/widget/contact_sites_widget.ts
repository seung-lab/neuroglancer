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

import './contact_sites_widget.css';

import {vec3} from 'gl-matrix';
import {annotationToJson, AnnotationType, Point} from 'neuroglancer/annotation';
import {setAnnotationHoverStateFromMouseState} from 'neuroglancer/annotation/selection';
import {SpontaneousAnnotationLayer} from 'neuroglancer/annotation/spontaneous_annotation_layer';
import {PairwiseContactSites} from 'neuroglancer/graph/contact_sites';
import {ManagedUserLayerWithSpecification} from 'neuroglancer/layer_specification';
import {SegmentationUserLayerWithGraph} from 'neuroglancer/segmentation_user_layer_with_graph';
import {StatusMessage} from 'neuroglancer/status';
import {TrackableBoolean, TrackableBooleanCheckbox} from 'neuroglancer/trackable_boolean';
import {TrackableRGB} from 'neuroglancer/util/color';
import {RefCounted} from 'neuroglancer/util/disposable';
import {removeFromParent} from 'neuroglancer/util/dom';
import {Uint64} from 'neuroglancer/util/uint64';
import {ColorWidget} from 'neuroglancer/widget/color';
import {MinimizableGroupWidget, MinimizableGroupWidgetWithHeader} from 'neuroglancer/widget/minimizable_group';
import {Uint64EntryWidget} from 'neuroglancer/widget/uint64_entry_widget';

const tempVec = vec3.create();

export class PairwiseContactSitesWidget extends RefCounted {
  groupElement = this.registerDisposer(new MinimizableGroupWidget('Contact Sites (for pair)'));
  private contactSiteGroupIdCounter: number;
  private segment1: Uint64|null = null;
  private segment2: Uint64|null = null;
  private segment1Label = document.createElement('label');
  private segment2Label = document.createElement('label');
  private removeSegment1Button = document.createElement('button');
  private removeSegment2Button = document.createElement('button');
  private contactSiteNameInput = document.createElement('input');

  constructor(
      private segmentationLayer: SegmentationUserLayerWithGraph,
      private createContactSitesUL:
          (pairwiseContactSiteGroup: PairwiseContactSites,
           minimizableGroupForContactSitesPair: MinimizableGroupWidgetWithHeader,
           annotationLayerForContactSitesPair: SpontaneousAnnotationLayer, firstSegment: Uint64,
           secondSegment: Uint64) => HTMLElement[]) {
    super();
    const pairwiseContactSiteLists = segmentationLayer.contactSites.pairwiseContactSiteLists;
    this.contactSiteGroupIdCounter = pairwiseContactSiteLists.length + 1;
    this.createSegmentInputElements();
    this.createGetContactSitesButton();
    // Create groups for existing contact site lists
    pairwiseContactSiteLists.forEach(contactSiteList => {
      this.createContactSiteGroupElement(contactSiteList, true);
    });
  }

  private deselectSegment1() {
    this.segment1 = null;
    this.segment1Label.textContent = 'Segment 1: Not selected';
    this.removeSegment1Button.style.display = 'none';
  }

  private deselectSegment2() {
    this.segment2 = null;
    this.segment2Label.textContent = 'Segment 2: Not selected';
    this.removeSegment2Button.style.display = 'none';
  }

  private createSegmentInputElements() {
    const {
      segment1Label,
      segment2Label,
      removeSegment1Button,
      removeSegment2Button,
      contactSiteNameInput
    } = this;
    const addSegmentLabel = document.createElement('span');
    addSegmentLabel.textContent = 'Enter segment IDs: ';
    const addSegmentInput = this.registerDisposer(new Uint64EntryWidget());
    addSegmentInput.element.id = 'add-segment-for-contact-site-lookup';
    const addSegmentElement = document.createElement('div');
    addSegmentElement.appendChild(addSegmentLabel);
    addSegmentElement.appendChild(addSegmentInput.element);
    const segment1Display = document.createElement('div');
    segment1Label.className = 'neuroglancer-select-text';
    segment1Label.textContent = 'Segment 1: Not selected';
    removeSegment1Button.textContent = 'x';
    removeSegment1Button.addEventListener('click', () => {
      this.deselectSegment1();
    });
    removeSegment1Button.style.display = 'none';
    segment1Display.appendChild(segment1Label);
    segment1Display.appendChild(removeSegment1Button);
    const segment2Display = document.createElement('div');
    segment2Label.className = 'neuroglancer-select-text';
    segment2Label.textContent = 'Segment 2: Not selected';
    removeSegment2Button.textContent = 'x';
    removeSegment2Button.addEventListener('click', () => {
      this.deselectSegment2();
    });
    removeSegment2Button.style.display = 'none';
    segment2Display.appendChild(segment2Label);
    segment2Display.appendChild(removeSegment2Button);
    this.registerDisposer(addSegmentInput.valuesEntered.add((values) => {
      for (let i = 0; i < values.length; i++) {
        if (this.segment1 && this.segment2) {
          StatusMessage.showTemporaryMessage('Two segments already selected.', 3000);
          break;
        }
        if (this.segment1) {
          if (Uint64.equal(this.segment1, values[i])) {
            StatusMessage.showTemporaryMessage(`Segment ${values[i]} already selected`, 3000);
          } else {
            this.segment2 = values[i];
            segment2Label.textContent = `Segment 2: ${this.segment2.toString()}`;
            removeSegment2Button.style.display = '';
          }
        } else {
          if (this.segment2 && Uint64.equal(this.segment2, values[i])) {
            StatusMessage.showTemporaryMessage(`Segment ${values[i]} already selected`, 3000);
          } else {
            this.segment1 = values[i];
            segment1Label.textContent = `Segment 1: ${this.segment1.toString()}`;
            removeSegment1Button.style.display = '';
          }
        }
      }
    }));
    const contactSiteNameInputLabel = document.createElement('label');
    contactSiteNameInputLabel.textContent = 'Alias for contact sites: ';
    contactSiteNameInputLabel.appendChild(contactSiteNameInput);
    contactSiteNameInput.placeholder = `Contact Sites for Pair #${this.contactSiteGroupIdCounter}`;
    this.groupElement.appendFixedChild(addSegmentElement);
    this.groupElement.appendFixedChild(segment1Display);
    this.groupElement.appendFixedChild(segment2Display);
    this.groupElement.appendFixedChild(contactSiteNameInputLabel);
  }

  private createGetContactSitesButton() {
    const {contactSiteNameInput, segmentationLayer} = this;
    const getContactSitesButton = document.createElement('button');
    getContactSitesButton.textContent = 'Get contact sites';
    getContactSitesButton.addEventListener('click', () => {
      if (this.segment1 === null || this.segment2 === null) {
        StatusMessage.showTemporaryMessage('You must enter two segment IDs first.', 5000);
      } else {
        const firstSegmentClone = this.segment1.clone();
        const secondSegmentClone = this.segment2.clone();
        const contactSitesForPairTitle = (contactSiteNameInput.value) ?
            contactSiteNameInput.value :
            `Contact Sites for Pair #${this.contactSiteGroupIdCounter}`;
        contactSiteNameInput.value = '';
        contactSiteNameInput.placeholder =
            `Contact Sites for Pair #${this.contactSiteGroupIdCounter + 1}`;
        this.contactSiteGroupIdCounter++;
        this.deselectSegment1();
        this.deselectSegment2();
        segmentationLayer.chunkedGraphLayer!
            .getContactSitesForPair(
                firstSegmentClone, secondSegmentClone,
                segmentationLayer.displayState.timestamp.value)
            .then((contactSites) => {
              if (contactSites.length === 0) {
                const status = new StatusMessage();
                status.setErrorMessage(`${firstSegmentClone.toString()} and ${
                    secondSegmentClone.toString()} do not have any contact sites`);
              } else {
                StatusMessage.showTemporaryMessage(
                    `Contact sites between ${firstSegmentClone.toString()} and ${
                        secondSegmentClone.toString()} retrieved!`,
                    5000);
                const annotationColor = new TrackableRGB(vec3.fromValues(0.0, 0.0, 0.0));
                annotationColor.value =
                    vec3.fromValues(Math.random(), Math.random(), Math.random());
                const pairwiseContactSiteGroup = new PairwiseContactSites(
                    firstSegmentClone, secondSegmentClone, contactSites, annotationColor,
                    contactSitesForPairTitle);
                segmentationLayer.contactSites.addContactSiteGroup(pairwiseContactSiteGroup);
                this.createContactSiteGroupElement(pairwiseContactSiteGroup, false);
              }
            });
      }
    });
    this.groupElement.appendFixedChild(getContactSitesButton);
  }

  private createAnnotationLayerFromContactSites(pairwiseContactSiteGroup: PairwiseContactSites) {
    const {segmentationLayer} = this;
    const layer = new ManagedUserLayerWithSpecification(
        pairwiseContactSiteGroup.name, {}, segmentationLayer.manager);
    let layerName: string|undefined;
    segmentationLayer.manager.layerManager.managedLayers.forEach(managedLayer => {
      if (managedLayer.layer === segmentationLayer) {
        layerName = managedLayer.name;
      }
    });
    const createAnnotationsJSON = () => {
      const annotationResult: any[] = [];
      pairwiseContactSiteGroup.contactSites.forEach(contactSite => {
        // Contact sites are stored in global (nm) coordinates but the user annotation layer
        // expects them in voxel coordinates, so divide by voxel size
        vec3.div(tempVec, contactSite.coordinate, segmentationLayer.manager.voxelSize.size);
        const contactSitePoint: Point = {
          id: '',
          segments: [pairwiseContactSiteGroup.segment1, pairwiseContactSiteGroup.segment2],
          description: `Area = ${contactSite.area} vx`,
          point: tempVec,
          type: AnnotationType.POINT
        };
        annotationResult.push(annotationToJson(contactSitePoint));
      });
      return annotationResult;
    };
    segmentationLayer.manager.initializeLayerFromSpec(layer, {
      type: 'annotation',
      name: pairwiseContactSiteGroup.name,
      linkedSegmentationLayer: layerName,
      annotations: createAnnotationsJSON()
    });
    segmentationLayer.manager.add(layer);
    StatusMessage.showTemporaryMessage('New annotation layer created!', 3000);
  }

  private createContactSiteGroupElement(
      pairwiseContactSiteGroup: PairwiseContactSites, existingGroup: boolean) {
    const {color: annotationColor, segment1, segment2} = pairwiseContactSiteGroup;
    const {segmentationLayer} = this;

    // Create annotation layer
    const annotationLayerForContactSitesPair = new SpontaneousAnnotationLayer(
        segmentationLayer.manager.chunkManager, segmentationLayer.transform, annotationColor);
    setAnnotationHoverStateFromMouseState(
        annotationLayerForContactSitesPair.annotationLayerState,
        segmentationLayer.manager.layerSelectedValues.mouseState);
    annotationLayerForContactSitesPair.renderLayers.forEach(renderLayer => {
      segmentationLayer.addRenderLayer(renderLayer);
    });

    // Create header elements for minimizable group
    const colorWidget =
        annotationLayerForContactSitesPair.registerDisposer(new ColorWidget(annotationColor));
    colorWidget.element.classList.add('neuroglancer-contact-site-color-select');
    const groupDisplayedOrHidden = new TrackableBoolean(true);
    const showOrHideContactSitesGroupCheckbox =
        new TrackableBooleanCheckbox(groupDisplayedOrHidden);
    showOrHideContactSitesGroupCheckbox.element.classList.add(
        'neuroglancer-toggle-contact-site-visibility');
    annotationLayerForContactSitesPair.registerDisposer(groupDisplayedOrHidden.changed.add(() => {
      if (groupDisplayedOrHidden.value) {
        annotationLayerForContactSitesPair.renderLayers.forEach(renderLayer => {
          renderLayer.ready = true;
        });
      } else {
        annotationLayerForContactSitesPair.renderLayers.forEach(renderLayer => {
          renderLayer.ready = false;
        });
      }
      segmentationLayer.manager.layerManager.layersChanged.dispatch();
    }));
    const deleteGroupButton = document.createElement('button');
    deleteGroupButton.textContent = 'x';
    deleteGroupButton.classList.add('neuroglancer-delete-contact-site-group');

    const minimizableGroupForContactSitesPair = new MinimizableGroupWidgetWithHeader(
        pairwiseContactSiteGroup.name,
        [showOrHideContactSitesGroupCheckbox.element, colorWidget.element, deleteGroupButton]);
    minimizableGroupForContactSitesPair.element.classList.add('neuroglancer-contact-site-group');
    deleteGroupButton.addEventListener('click', () => {
      const deleteConfirmed = confirm(
          `Are you sure you want to delete contact sites group ${pairwiseContactSiteGroup.name}?`);
      if (deleteConfirmed) {
        segmentationLayer.contactSites.deleteContactSiteGroup(pairwiseContactSiteGroup);
        annotationLayerForContactSitesPair.renderLayers.forEach(renderLayer => {
          segmentationLayer.removeRenderLayer(renderLayer);
        });
        annotationLayerForContactSitesPair.dispose();
        removeFromParent(minimizableGroupForContactSitesPair.element);
      }
    });
    if (existingGroup) {
      // Minimize existing groups by default
      const groupContent = minimizableGroupForContactSitesPair.element.getElementsByClassName(
          'neuroglancer-minimizable-group-content');
      groupContent[0].classList.toggle('minimized');
      const groupTitle = minimizableGroupForContactSitesPair.element.getElementsByClassName(
          'neuroglancer-minimizable-group-title');
      groupTitle[0].classList.toggle('minimized');
    }

    const exportToAnnotationLayerButton = document.createElement('button');
    exportToAnnotationLayerButton.textContent = 'Export to annotation layer';
    exportToAnnotationLayerButton.addEventListener('click', () => {
      this.createAnnotationLayerFromContactSites(pairwiseContactSiteGroup);
    });
    minimizableGroupForContactSitesPair.appendFixedChild(exportToAnnotationLayerButton);

    const segment1Div = document.createElement('div');
    segment1Div.textContent = `Segment 1: ${segment1.toString()}`;
    segment1Div.classList.add('neuroglancer-select-text');
    const segment2Div = document.createElement('div');
    segment2Div.textContent = `Segment 2: ${segment2.toString()}`;
    segment2Div.classList.add('neuroglancer-select-text');
    minimizableGroupForContactSitesPair.appendFixedChild(segment1Div);
    minimizableGroupForContactSitesPair.appendFixedChild(segment2Div);

    // Create contact site list elements and color change event
    const elementsList = this.createContactSitesUL(
        pairwiseContactSiteGroup, minimizableGroupForContactSitesPair,
        annotationLayerForContactSitesPair, segment1, segment2);
    annotationLayerForContactSitesPair.registerDisposer(colorWidget.model.changed.add(() => {
      elementsList.forEach(element => {
        const positionElement =
            element.querySelector('.neuroglancer-multicut-voxel-coordinates-link');
        (<HTMLElement>positionElement!).style.color = colorWidget.model.toString();
      });
    }));

    this.groupElement.appendFlexibleChild(minimizableGroupForContactSitesPair.element);
  }
}

// The below commented out code is for an abandoned feature (Finding all contact partners
// that a root has in a dataset). I found that there are simply too many partners for this to be
// useful and easy to display in Neuroglancer. Leaving this code in here in case we want to be
// pick this up again at some point. - Manuel 11/2019

// const temp = new Uint64();

// export class AllContactSitesForRootWidget extends RefCounted {
//   groupElement =
//       this.registerDisposer(new MinimizableGroupWidget('Contact Sites (for single root)'));

//   constructor(segmentationLayer: SegmentationUserLayerWithGraph) {
//     super();
//     const addSegmentLabel = document.createElement('span');
//     addSegmentLabel.textContent = 'Enter segment ID: ';
//     const addSegmentInput = document.createElement('input');
//     addSegmentLabel.appendChild(addSegmentInput);
//     const contactSiteNameInput = document.createElement('input');
//     const contactSiteNameInputLabel = document.createElement('label');
//     contactSiteNameInputLabel.textContent = 'Alias for contact sites: ';
//     contactSiteNameInputLabel.appendChild(contactSiteNameInput);
//     addSegmentInput.addEventListener('change', () => {
//       contactSiteNameInput.placeholder = addSegmentInput.value;
//     });
//     const getContactSitesButton = document.createElement('button');
//     getContactSitesButton.textContent = 'Get contact sites';
//     getContactSitesButton.addEventListener('click', () => {
//       const validU64 = temp.tryParseString(addSegmentInput.value, 10);
//       if (!validU64) {
//         StatusMessage.showTemporaryMessage(`${addSegmentInput.value} is not a valid uint64`,
//         4000);
//       } else {
//         // const rootString = addSegmentInput.value;
//         const selectedRoot = temp.clone();
//         const contactPartnersGroupName =
//             (contactSiteNameInput.value) ? contactSiteNameInput.value : addSegmentInput.value;
//         addSegmentInput.value = '';
//         contactSiteNameInput.value = '';
//         contactSiteNameInput.placeholder = '';
//         segmentationLayer.chunkedGraphLayer!
//             .getContactPartnersForRoot(selectedRoot,
//             segmentationLayer.displayState.timestamp.value) .then((contactPartners) => {
//               if (contactPartners.size === 0) {
//                 StatusMessage.showTemporaryMessage(
//                     `${selectedRoot.toString()} has no contact partners`);
//               } else {
//                 StatusMessage.showTemporaryMessage(
//                     `Contact partners of ${selectedRoot.toString()} retrieved!`, 5000);
//                 const contactPartnersGroup = new ContactPartnersForRoot(
//                     selectedRoot, contactPartners, contactPartnersGroupName);
//                 segmentationLayer.contactSites.addContactSiteGroup(contactPartnersGroup);
//                 this.createContactPartnerGroupElement(contactPartnersGroup, false);
//               }
//             });
//       }
//     });
//     this.groupElement.appendFixedChild(addSegmentLabel);
//     this.groupElement.appendFixedChild(contactSiteNameInputLabel);
//     this.groupElement.appendFixedChild(getContactSitesButton);
//     // Create groups for existing contact partner lists
//     const contactPartnersForRootList = segmentationLayer.contactSites.contactPartnersForRootList;
//     contactPartnersForRootList.forEach(contactPartnersForRoot => {
//       this.createContactPartnerGroupElement(contactPartnersForRoot, true);
//     });
//   }

//   private createContactPartnerGroupElement(
//       contactPartners: ContactPartnersForRoot, existingGroup: boolean) {
//     const deleteGroupButton = document.createElement('button');
//     deleteGroupButton.textContent = 'x';
//     deleteGroupButton.style.verticalAlign = 'bottom';

//     const minimizableGroupForContactPartners =
//         new MinimizableGroupWidgetWithHeader(contactPartners.name, [deleteGroupButton]);
//     minimizableGroupForContactPartners.element.style.marginLeft = '6%';
//     deleteGroupButton.addEventListener('click', () => {
//       const deleteConfirmed =
//           confirm(`Are you sure you want to delete contact sites group
//           ${contactPartners.name}?`);
//       if (deleteConfirmed) {
//         removeFromParent(minimizableGroupForContactPartners.element);
//       }
//     });

//     if (existingGroup) {
//       // Minimize existing groups by default
//       const groupContent = minimizableGroupForContactPartners.element.getElementsByClassName(
//           'neuroglancer-minimizable-group-content');
//       groupContent[0].classList.toggle('minimized');
//       const groupTitle = minimizableGroupForContactPartners.element.getElementsByClassName(
//           'neuroglancer-minimizable-group-title');
//       groupTitle[0].classList.toggle('minimized');
//     }

//     const rootSegmentDiv = document.createElement('div');
//     rootSegmentDiv.textContent = `Root segment: ${contactPartners.root.toString()}`;
//     rootSegmentDiv.classList.add('neuroglancer-select-text');
//     minimizableGroupForContactPartners.appendFixedChild(rootSegmentDiv);

//     const contactPartnerList = document.createElement('ul');
//     for (const [partner, areas] of contactPartners.partners.entries()) {
//       const partnerElement = document.createElement('li');
//       partnerElement.textContent = partner.toString();
//       const partnerDetailList = document.createElement('ul');
//       const numberOfContactsElement = document.createElement('li');
//       numberOfContactsElement.textContent = `${areas.length} contact sites`;
//       const areaElement = document.createElement('li');
//       const sumOfAreas = areas.reduce((areaSum, area) => {
//         return areaSum + area;
//       });
//       areaElement.textContent = `Total area across all = ${sumOfAreas} vx`;
//       partnerDetailList.appendChild(numberOfContactsElement);
//       partnerDetailList.appendChild(areaElement);
//       partnerElement.appendChild(partnerDetailList);
//       contactPartnerList.appendChild(partnerElement);
//     }
//     minimizableGroupForContactPartners.appendFlexibleChild(contactPartnerList);

//     this.groupElement.appendFlexibleChild(minimizableGroupForContactPartners.element);
//   }
// }
