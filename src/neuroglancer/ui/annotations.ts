/**
 * @license
 * Copyright 2018 Google Inc.
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
 * @file User interface for display and editing annotations.
 */

import './annotations.css';

import debounce from 'lodash/debounce';
import {Annotation, AnnotationReference, AnnotationSource, AnnotationTag, AnnotationType, AxisAlignedBoundingBox, Collection, Ellipsoid, getAnnotationTypeHandler, Line, LineStrip, LocalAnnotationSource, makeAnnotationId, Point} from 'neuroglancer/annotation';
import {AnnotationLayer, AnnotationLayerState, PerspectiveViewAnnotationLayer, SliceViewAnnotationLayer} from 'neuroglancer/annotation/frontend';
import {DataFetchSliceViewRenderLayer, MultiscaleAnnotationSource} from 'neuroglancer/annotation/frontend_source';
import {setAnnotationHoverStateFromMouseState} from 'neuroglancer/annotation/selection';
import {MouseSelectionState, UserLayer} from 'neuroglancer/layer';
import {VoxelSize} from 'neuroglancer/navigation_state';
import {SegmentationDisplayState} from 'neuroglancer/segmentation_display_state/frontend';
import {StatusMessage} from 'neuroglancer/status';
import {TrackableAlphaValue, trackableAlphaValue} from 'neuroglancer/trackable_alpha';
import {TrackableBoolean, TrackableBooleanCheckbox} from 'neuroglancer/trackable_boolean';
import {registerNested, TrackableValueInterface, WatchableRefCounted, WatchableValue} from 'neuroglancer/trackable_value';
import {registerTool, Tool} from 'neuroglancer/ui/tool';
import {TrackableRGB} from 'neuroglancer/util/color';
import {Borrowed, Owned, RefCounted} from 'neuroglancer/util/disposable';
import {removeChildren, removeFromParent} from 'neuroglancer/util/dom';
import {mat3, mat3FromMat4, mat4, transformVectorByMat4, vec3} from 'neuroglancer/util/geom';
import {verifyObject, verifyObjectProperty, verifyOptionalInt, verifyOptionalString, verifyString} from 'neuroglancer/util/json';
import {NullarySignal} from 'neuroglancer/util/signal';
import {formatBoundingBoxVolume, formatIntegerBounds, formatIntegerPoint, formatLength} from 'neuroglancer/util/spatial_units';
import {Uint64} from 'neuroglancer/util/uint64';
import {WatchableVisibilityPriority} from 'neuroglancer/visibility_priority/frontend';
import {makeCloseButton} from 'neuroglancer/widget/close_button';
import {ColorWidget} from 'neuroglancer/widget/color';
import {MinimizableGroupWidget} from 'neuroglancer/widget/minimizable_group';
import {RangeWidget} from 'neuroglancer/widget/range';
import {StackView, Tab} from 'neuroglancer/widget/tab_view';
import {makeTextIconButton} from 'neuroglancer/widget/text_icon_button';
import {Uint64EntryWidget} from 'neuroglancer/widget/uint64_entry_widget';

const Papa = require('papaparse');

type AnnotationIdAndPart = {
  id: string,
  partIndex?: number,
  multiple?: Set<string>,
  ungroupable?: boolean
};

type MultiTool = typeof PlacePointTool|typeof PlaceBoundingBoxTool|typeof PlaceLineTool|
    typeof PlaceSphereTool|typeof PlaceLineStripTool|typeof MultiStepAnnotationTool;

export class AnnotationSegmentListWidget extends RefCounted {
  element = document.createElement('div');
  private addSegmentWidget = this.registerDisposer(new Uint64EntryWidget());
  private segmentationState: SegmentationDisplayState|undefined|null;
  private debouncedUpdateView = debounce(() => this.updateView(), 0);
  constructor(
      public reference: Borrowed<AnnotationReference>,
      public annotationLayer: AnnotationLayerState) {
    super();
    this.element.className = 'neuroglancer-annotation-segment-list';
    const {addSegmentWidget} = this;
    addSegmentWidget.element.style.display = 'inline-block';
    addSegmentWidget.element.title = 'Associate segments';
    this.element.appendChild(addSegmentWidget.element);
    this.registerDisposer(annotationLayer.segmentationState.changed.add(this.debouncedUpdateView));
    this.registerDisposer(() => this.unregisterSegmentationState());
    this.registerDisposer(this.addSegmentWidget.valuesEntered.add(values => {
      const annotation = this.reference.value;
      if (annotation == null) {
        return;
      }
      const existingSegments = annotation.segments;
      const segments = [...(existingSegments || []), ...values];
      const newAnnotation = {...annotation, segments};
      this.annotationLayer.source.update(this.reference, newAnnotation);
      this.annotationLayer.source.commit(this.reference);
    }));
    this.registerDisposer(reference.changed.add(this.debouncedUpdateView));
    this.updateView();
  }

  private unregisterSegmentationState() {
    const {segmentationState} = this;
    if (segmentationState != null) {
      segmentationState.rootSegments.changed.remove(this.debouncedUpdateView);
      segmentationState.segmentColorHash.changed.remove(this.debouncedUpdateView);
      segmentationState.segmentSelectionState.changed.remove(this.debouncedUpdateView);
      this.segmentationState = undefined;
    }
  }

  private updateView() {
    const segmentationState = this.annotationLayer.segmentationState.value;
    if (segmentationState !== this.segmentationState) {
      this.unregisterSegmentationState();
      this.segmentationState = segmentationState;
      if (segmentationState != null) {
        segmentationState.rootSegments.changed.add(this.debouncedUpdateView);
        segmentationState.segmentColorHash.changed.add(this.debouncedUpdateView);
        segmentationState.segmentSelectionState.changed.add(this.debouncedUpdateView);
      }
    }

    const {element} = this;
    // Remove existing segment representations.
    for (let child = this.addSegmentWidget.element.nextElementSibling; child !== null;) {
      const next = child.nextElementSibling;
      element.removeChild(child);
      child = next;
    }
    element.style.display = 'none';
    const annotation = this.reference.value;
    if (annotation == null) {
      return;
    }
    const segments = annotation.segments;
    if (segmentationState === null) {
      return;
    }
    element.style.display = '';
    if (segments === undefined || segments.length === 0) {
      return;
    }
    const segmentColorHash = segmentationState ? segmentationState.segmentColorHash : undefined;
    segments.forEach((segment, index) => {
      if (index !== 0) {
        element.appendChild(document.createTextNode(' '));
      }
      const child = document.createElement('span');
      child.title =
          'Double click to toggle segment visibility, control+click to disassociate segment from annotation.';
      child.className = 'neuroglancer-annotation-segment-item';
      child.textContent = segment.toString();
      if (segmentationState !== undefined) {
        child.style.backgroundColor = segmentColorHash!.computeCssColor(segment);
        child.addEventListener('mouseenter', () => {
          segmentationState.segmentSelectionState.set(segment);
        });
        child.addEventListener('mouseleave', () => {
          segmentationState.segmentSelectionState.set(null);
        });
        child.addEventListener('dblclick', (event: MouseEvent) => {
          if (event.ctrlKey) {
            return;
          }
          if (segmentationState.rootSegments.has(segment)) {
            segmentationState.rootSegments.delete(segment);
          } else {
            segmentationState.rootSegments.add(segment);
          }
        });
      }
      child.addEventListener('click', (event: MouseEvent) => {
        if (!event.ctrlKey) {
          return;
        }
        const existingSegments = annotation.segments || [];
        const newSegments = existingSegments.filter(x => !Uint64.equal(segment, x));
        const newAnnotation = {...annotation, segments: newSegments ? newSegments : undefined};
        this.annotationLayer.source.update(this.reference, newAnnotation);
        this.annotationLayer.source.commit(this.reference);
      });
      element.appendChild(child);
    });
  }
}

export class SelectedAnnotationState extends RefCounted implements
    TrackableValueInterface<AnnotationIdAndPart|undefined> {
  private value_: AnnotationIdAndPart|undefined;
  changed = new NullarySignal();

  private annotationLayer: AnnotationLayerState|undefined;
  private reference_: Owned<AnnotationReference>|undefined;

  get reference() {
    return this.reference_;
  }

  constructor(public annotationLayerState: Owned<WatchableRefCounted<AnnotationLayerState>>) {
    super();
    this.registerDisposer(annotationLayerState);
    this.registerDisposer(annotationLayerState.changed.add(this.validate));
    this.updateAnnotationLayer();
    this.reference_ = undefined;
    this.value_ = undefined;
  }

  get value() {
    return this.value_;
  }

  get validValue() {
    return this.annotationLayer && this.value_;
  }

  set value(value: AnnotationIdAndPart|undefined) {
    this.value_ = value;
    const reference = this.reference_;
    if (reference !== undefined) {
      if (value === undefined || reference.id !== value.id) {
        this.unbindReference();
      }
    }
    this.validate();
    this.changed.dispatch();
  }

  private updateAnnotationLayer() {
    const annotationLayer = this.annotationLayerState.value;
    if (annotationLayer === this.annotationLayer) {
      return false;
    }
    this.unbindLayer();
    this.annotationLayer = annotationLayer;
    if (annotationLayer !== undefined) {
      annotationLayer.source.changed.add(this.validate);
    }
    return true;
  }

  private unbindLayer() {
    if (this.annotationLayer !== undefined) {
      this.annotationLayer.source.changed.remove(this.validate);
      this.annotationLayer = undefined;
    }
  }

  disposed() {
    this.unbindLayer();
    this.unbindReference();
    super.disposed();
  }

  private unbindReference() {
    const reference = this.reference_;
    if (reference !== undefined) {
      reference.changed.remove(this.referenceChanged);
      this.reference_ = undefined;
    }
  }

  private referenceChanged = (() => {
    this.validate();
    this.changed.dispatch();
  });

  private validate = (() => {
    const updatedLayer = this.updateAnnotationLayer();
    const {annotationLayer} = this;
    if (annotationLayer !== undefined) {
      const value = this.value_;
      if (value !== undefined) {
        let reference = this.reference_;
        if (reference !== undefined && reference.id !== value.id) {
          // Id changed.
          value.id = reference.id;
        } else if (reference === undefined) {
          reference = this.reference_ = annotationLayer.source.getReference(value.id);
          reference.changed.add(this.referenceChanged);
        }
        if (reference.value === null) {
          this.unbindReference();
          this.value = undefined;
          return;
        }
      } else {
        this.unbindReference();
      }
    }
    if (updatedLayer) {
      this.changed.dispatch();
    }
  });

  toJSON() {
    const value = this.value_;
    if (value === undefined) {
      return undefined;
    }
    if (value.partIndex === 0) {
      return value.id;
    }
    return value;
  }
  reset() {
    this.value = undefined;
  }
  restoreState(x: any) {
    if (x === undefined) {
      this.value = undefined;
      return;
    }
    if (typeof x === 'string') {
      this.value = {'id': x, 'partIndex': 0};
      return;
    }
    verifyObject(x);
    this.value = {
      'id': verifyObjectProperty(x, 'id', verifyString),
      'partIndex': verifyObjectProperty(x, 'partIndex', verifyOptionalInt),
    };
  }
}

const tempVec3 = vec3.create();

function makePointLink(
    point: vec3, transform: mat4, voxelSize: VoxelSize,
    setSpatialCoordinates?: (point: vec3) => void) {
  const spatialPoint = vec3.transformMat4(vec3.create(), point, transform);
  const positionText = formatIntegerPoint(voxelSize.voxelFromSpatial(tempVec3, spatialPoint));
  if (setSpatialCoordinates !== undefined) {
    const element = document.createElement('span');
    element.className = 'neuroglancer-voxel-coordinates-link';
    element.textContent = positionText;
    element.title = `Center view on voxel coordinates ${positionText}.`;
    element.addEventListener('click', () => {
      setSpatialCoordinates(spatialPoint);
    });
    return element;
  } else {
    return document.createTextNode(positionText);
  }
}

export function getPositionSummary(
    element: HTMLElement, annotation: Annotation, transform: mat4, voxelSize: VoxelSize,
    setSpatialCoordinates?: (point: vec3) => void) {
  const makePointLinkWithTransform = (point: vec3) =>
      makePointLink(point, transform, voxelSize, setSpatialCoordinates);

  switch (annotation.type) {
    case AnnotationType.AXIS_ALIGNED_BOUNDING_BOX:
    case AnnotationType.LINE:
      element.appendChild(makePointLinkWithTransform(annotation.pointA));
      element.appendChild(document.createTextNode('–'));
      element.appendChild(makePointLinkWithTransform(annotation.pointB));
      break;
    case AnnotationType.POINT:
      element.appendChild(makePointLinkWithTransform(annotation.point));
      break;
    case AnnotationType.ELLIPSOID:
      element.appendChild(makePointLinkWithTransform(annotation.center));
      const transformedRadii = transformVectorByMat4(tempVec3, annotation.radii, transform);
      voxelSize.voxelFromSpatial(transformedRadii, transformedRadii);
      element.appendChild(document.createTextNode('±' + formatIntegerBounds(transformedRadii)));
      break;
    case AnnotationType.LINE_STRIP:
    case AnnotationType.COLLECTION: {
      element.appendChild(makePointLinkWithTransform(annotation.source));
      break;
    }
  }
}

function getCenterPosition(annotation: Annotation, transform: mat4) {
  const center = vec3.create();
  switch (annotation.type) {
    case AnnotationType.AXIS_ALIGNED_BOUNDING_BOX:
    case AnnotationType.LINE:
      vec3.add(center, annotation.pointA, annotation.pointB);
      vec3.scale(center, center, 0.5);
      break;
    case AnnotationType.POINT:
      vec3.copy(center, annotation.point);
      break;
    case AnnotationType.ELLIPSOID:
      vec3.copy(center, annotation.center);
      break;
    case AnnotationType.LINE_STRIP:
    case AnnotationType.COLLECTION:
      vec3.copy(center, annotation.source);
      break;
  }
  return vec3.transformMat4(center, center, transform);
}

export class AnnotationLayerView extends Tab {
  private annotationListContainer = document.createElement('ul');
  private annotationListElements = new Map<string, HTMLElement>();
  private annotationTags = new Map<number, HTMLOptionElement>();
  private previousSelectedId: string|undefined;
  private previousHoverId: string|undefined;
  private updated = false;
  public toolbox: HTMLDivElement;
  groupVisualization = this.registerDisposer(new MinimizableGroupWidget('Visualization'));
  groupAnnotations = this.registerDisposer(new MinimizableGroupWidget('Annotations'));

  constructor(
      public layer: Borrowed<UserLayerWithAnnotations>,
      public state: Owned<SelectedAnnotationState>,
      public annotationLayer: Owned<AnnotationLayerState>, public voxelSize: Owned<VoxelSize>,
      public setSpatialCoordinates: (point: vec3) => void) {
    super();
    this.element.classList.add('neuroglancer-annotation-layer-view');
    this.annotationListContainer.classList.add('neuroglancer-annotation-list');
    this.registerDisposer(state);
    this.registerDisposer(voxelSize);
    this.registerDisposer(annotationLayer);
    const {source} = annotationLayer;
    const updateView = () => {
      this.updated = false;
      this.updateView();
    };
    this.registerDisposer(
        source.childAdded.add((annotation) => this.addAnnotationElement(annotation)));
    this.registerDisposer(
        source.childUpdated.add((annotation) => this.updateAnnotationElement(annotation)));
    this.registerDisposer(
        source.childDeleted.add((annotationId) => this.deleteAnnotationElement(annotationId)));
    this.registerDisposer(this.visibility.changed.add(() => this.updateView()));
    this.registerDisposer(annotationLayer.transform.changed.add(updateView));
    this.updateView();

    this.toolbox = document.createElement('div');
    const {toolbox} = this;
    toolbox.className = 'neuroglancer-annotation-toolbox';

    layer.initializeAnnotationLayerViewTab(this);

    {
      const widget = this.registerDisposer(new RangeWidget(this.annotationLayer.fillOpacity));
      widget.promptElement.textContent = 'Fill opacity';
      this.groupVisualization.appendFixedChild(widget.element);
    }

    const colorPicker = this.registerDisposer(new ColorWidget(this.annotationLayer.color));
    colorPicker.element.title = 'Change annotation display color';
    toolbox.appendChild(colorPicker.element);
    if (!annotationLayer.source.readonly) {
      const pointButton = document.createElement('button');
      pointButton.textContent = getAnnotationTypeHandler(AnnotationType.POINT).icon;
      pointButton.title = 'Annotate point';
      pointButton.addEventListener('click', () => {
        changeTool(AnnotationType.POINT);
      });
      toolbox.appendChild(pointButton);


      const boundingBoxButton = document.createElement('button');
      boundingBoxButton.textContent =
          getAnnotationTypeHandler(AnnotationType.AXIS_ALIGNED_BOUNDING_BOX).icon;
      boundingBoxButton.title = 'Annotate bounding box';
      boundingBoxButton.addEventListener('click', () => {
        changeTool(AnnotationType.AXIS_ALIGNED_BOUNDING_BOX);
      });
      toolbox.appendChild(boundingBoxButton);


      const lineButton = document.createElement('button');
      lineButton.textContent = getAnnotationTypeHandler(AnnotationType.LINE).icon;
      lineButton.title = 'Annotate line';
      lineButton.addEventListener('click', () => {
        changeTool(AnnotationType.LINE);
      });
      toolbox.appendChild(lineButton);


      const ellipsoidButton = document.createElement('button');
      ellipsoidButton.textContent = getAnnotationTypeHandler(AnnotationType.ELLIPSOID).icon;
      ellipsoidButton.title = 'Annotate ellipsoid';
      ellipsoidButton.addEventListener('click', () => {
        changeTool(AnnotationType.ELLIPSOID);
      });
      toolbox.appendChild(ellipsoidButton);

      // Collections //
      const mskey = 'neuroglancer-collection-tool';
      const childms = 'neuroglancer-child-collection-tool';
      const collectionButton = document.createElement('button');
      const multipointButton = document.createElement('button');
      const changeTool = (toolset?: AnnotationType) => {
        const currentTool = <PlaceAnnotationTool>this.layer.tool.value;
        const toLineStrip = toolset === AnnotationType.LINE_STRIP;
        const toCollection = toolset === AnnotationType.COLLECTION;
        const keyRemoveGen = (typekey: string) => () => {
          let key = toolbox.querySelector(`.${typekey}`);
          if (key) {
            key.classList.remove(typekey);
          }
        };
        const remActive = keyRemoveGen(mskey);
        const remChild = keyRemoveGen(childms);
        const activeKey = () => {
          if (toLineStrip) {
            multipointButton.classList.add(mskey);
          } else if (toCollection) {
            collectionButton.classList.add(mskey);
          }
        };
        const setTool = (parent?: any) => {
          let tool;
          switch (toolset) {
            case AnnotationType.POINT:
              tool = PlacePointTool;
              break;
            case AnnotationType.LINE:
              tool = PlaceLineTool;
              break;
            case AnnotationType.AXIS_ALIGNED_BOUNDING_BOX:
              tool = PlaceBoundingBoxTool;
              break;
            case AnnotationType.ELLIPSOID:
              tool = PlaceSphereTool;
              break;
            case AnnotationType.LINE_STRIP:
              tool = PlaceLineStripTool;
              break;
            case AnnotationType.COLLECTION:
              tool = MultiStepAnnotationTool;
              break;
          }
          if (parent) {
            if (parent.childTool) {
              parent.childTool.dispose();
            }
            parent.childTool = new (<any>tool)(this.layer, {toolbox});
          } else {
            this.layer.tool.value = tool ? new tool(this.layer, {toolbox}) : void (0);
          }
        };

        if (currentTool && toolset !== void (0)) {
          const isLineStrip = currentTool.annotationType === AnnotationType.LINE_STRIP;
          const isCollection = currentTool.annotationType === AnnotationType.COLLECTION;
          const multitool = <any>this.layer.tool.value!;

          if (isCollection && !toCollection) {
            const {childTool} = multitool;
            const isChildLineStrip =
                childTool ? childTool.annotationType === AnnotationType.LINE_STRIP : void (0);

            if (isChildLineStrip && toLineStrip) {
              multipointButton.classList.toggle('neuroglancer-linestrip-looped');
              childTool.looped = !childTool.looped;
            } else {
              remChild();
              if (toLineStrip) {
                multipointButton.classList.add(childms);
              }
              // trust me, it work
              setTool(/*parent=*/multitool);
            }
            this.layer.tool.changed.dispatch();
          } else if (isCollection && toCollection) {
            // noop
          } else if (isLineStrip && toLineStrip) {
            multipointButton.classList.toggle('neuroglancer-linestrip-looped');
            multitool.looped = !multitool.looped;
            this.layer.tool.changed.dispatch();
          } else {
            remActive();
            activeKey();
            setTool();
          }
        } else {
          remActive();
          remChild();
          activeKey();
          setTool();
        }
      };
      const activeTool = (<PlaceLineStripTool>this.layer.tool.value);
      if (activeTool &&
          (activeTool.annotationType === AnnotationType.LINE_STRIP ||
           activeTool.annotationType === AnnotationType.COLLECTION)) {
        activeTool.toolbox = toolbox;
        if (activeTool.looped !== void (0)) {
          multipointButton.classList.add(mskey);
        } else {
          collectionButton.classList.add(mskey);
        }
      }
      const separator = document.createElement('button');
      separator.disabled = true;
      separator.style.padding = '1px';
      separator.style.border = '1px';
      toolbox.append(separator);
      collectionButton.textContent = getAnnotationTypeHandler(AnnotationType.COLLECTION).icon;
      collectionButton.title = 'Group together multiple annotations';
      collectionButton.addEventListener('click', () => {
        changeTool(AnnotationType.COLLECTION);
      });
      toolbox.appendChild(collectionButton);

      multipointButton.textContent = getAnnotationTypeHandler(AnnotationType.LINE_STRIP).icon;
      multipointButton.title = 'Annotate multiple connected points';
      multipointButton.addEventListener('click', () => {
        changeTool(AnnotationType.LINE_STRIP);
      });
      toolbox.appendChild(multipointButton);

      const confirmMultiButton = document.createElement('button');
      {
        confirmMultiButton.textContent = '✔️';
        confirmMultiButton.title = 'Confirm Annotation';
        confirmMultiButton.className = 'neuroglancer-multistep-confirm-button';
        confirmMultiButton.addEventListener('click', () => {
          if (this.layer.tool.value) {
            (<PlaceAnnotationTool>this.layer.tool.value).complete();
          }
        });
      }

      const abortMultiButton = document.createElement('button');
      {
        abortMultiButton.textContent = '❌';
        abortMultiButton.title = 'Abort Annotation';
        abortMultiButton.addEventListener('click', () => {
          if (this.layer.tool.value) {
            // Not undo able, does not change state? it might but it hasn't been investigated
            StatusMessage.showTemporaryMessage(`Annotation cancelled.`, 3000);
            // HACK: force < 1 = 1
            // Expected behavior is to cancel any in progress annotations and deactivate the tool
            /*if (this.layer.tool.refCount < 1) {
              this.layer.tool.refCount = 1;
            }*/
            // debugger;
            // this.layer.tool.dispose();
            changeTool();
            // this.layer.tool.value.dispose();
            this.layer.tool.changed.dispatch();
          }
        });
      }

      toolbox.append(confirmMultiButton, abortMultiButton);
    }

    {
      const jumpingShowsSegmentationCheckbox = this.registerDisposer(
          new TrackableBooleanCheckbox(this.annotationLayer.annotationJumpingDisplaysSegmentation));
      const label = document.createElement('label');
      label.textContent = 'Bracket shortcuts show segmentation: ';
      label.appendChild(jumpingShowsSegmentationCheckbox.element);
      this.groupVisualization.appendFixedChild(label);
    }

    {
      const annotationTagFilter = document.createElement('select');
      annotationTagFilter.id = 'annotation-tag-filter';
      annotationTagFilter.add(new Option('View all', '0', true, true));
      const createOptionText = (tag: AnnotationTag) => {
        return '#' + tag.label + ' (id: ' + tag.id.toString() + ')';
      };
      for (const tag of source.getTags()) {
        const option = new Option(createOptionText(tag), tag.id.toString(), false, false);
        this.annotationTags.set(tag.id, option);
        annotationTagFilter.add(option);
      }
      this.registerDisposer(source.tagAdded.add((tag) => {
        const option = new Option(createOptionText(tag), tag.id.toString(), false, false);
        this.annotationTags.set(tag.id, option);
        annotationTagFilter.add(option);
      }));
      this.registerDisposer(source.tagUpdated.add((tag) => {
        const option = this.annotationTags.get(tag.id)!;
        option.text = createOptionText(tag);
        for (const annotation of source) {
          if (this.annotationLayer.source.isAnnotationTaggedWithTag(annotation.id, tag.id)) {
            this.updateAnnotationElement(annotation, false);
          }
        }
      }));
      this.registerDisposer(source.tagDeleted.add((tagId) => {
        annotationTagFilter.removeChild(this.annotationTags.get(tagId)!);
        this.annotationTags.delete(tagId);
        for (const annotation of source) {
          this.updateAnnotationElement(annotation, false);
        }
      }));
      annotationTagFilter.addEventListener('change', () => {
        const tagIdSelected = parseInt(annotationTagFilter.selectedOptions[0].value, 10);
        this.annotationLayer.selectedAnnotationTagId.value = tagIdSelected;
        this.filterAnnotationsByTag(tagIdSelected);
      });
      const label = document.createElement('label');
      label.textContent = 'Filter annotation list by tag: ';
      label.appendChild(annotationTagFilter);
      this.groupVisualization.appendFixedChild(label);
    }

    {
      const exportToCSVButton = document.createElement('button');
      const importCSVButton = document.createElement('button');
      const importCSVForm = document.createElement('input');
      exportToCSVButton.id = 'exportToCSVButton';
      exportToCSVButton.textContent = 'Export to CSV';
      exportToCSVButton.addEventListener('click', () => {
        this.exportToCSV();
      });
      importCSVForm.id = 'importCSVForm';
      importCSVForm.type = 'file';
      importCSVForm.accept = 'text/csv';
      importCSVForm.multiple = true;
      importCSVForm.style.display = 'none';
      importCSVButton.textContent = 'Import from CSV';
      importCSVButton.addEventListener('click', () => {
        importCSVForm.click();
      });
      importCSVForm.addEventListener('change', () => {
        this.importCSV(importCSVForm.files);
        importCSVForm.files = null;
      });
      const csvContainer = document.createElement('span');
      csvContainer.append(exportToCSVButton, importCSVButton, importCSVForm);
      this.groupAnnotations.appendFixedChild(csvContainer);
    }

    this.groupAnnotations.appendFixedChild(toolbox);
    this.groupAnnotations.appendFlexibleChild(this.annotationListContainer);
    this.element.appendChild(this.groupVisualization.element);
    this.element.appendChild(this.groupAnnotations.element);

    this.annotationListContainer.addEventListener('mouseleave', () => {
      this.annotationLayer.hoverState.value = undefined;
    });
    this.registerDisposer(
        this.annotationLayer.hoverState.changed.add(() => this.updateHoverView()));
    this.registerDisposer(this.state.changed.add(() => this.updateSelectionView()));
  }

  private updateSelectionView() {
    const selectedValue = this.state.value;
    let newSelectedId: string|undefined;
    let multiple: string[]|undefined;
    if (selectedValue !== undefined) {
      newSelectedId = selectedValue.id;
      multiple = selectedValue.multiple ? Array.from(selectedValue.multiple) : void (0);
    }
    const {previousSelectedId} = this;
    if (newSelectedId === previousSelectedId) {
      return;
    }
    if (previousSelectedId !== undefined) {
      const element = this.annotationListElements.get(previousSelectedId);
      if (element !== undefined) {
        element.classList.remove('neuroglancer-annotation-selected');
        if (multiple && multiple.length && multiple.includes(previousSelectedId)) {
          element.classList.add('neuroglancer-annotation-multiple');
        }
      }
    }
    if (newSelectedId !== undefined) {
      const element = this.annotationListElements.get(newSelectedId);
      if (element !== undefined) {
        element.classList.add('neuroglancer-annotation-selected');
        element.scrollIntoView();
        // Scrolls just a pixel too far, this makes it look prettier
        this.annotationListContainer.scrollTop -= 1;
        if (multiple && multiple.length) {
          element.classList.add('neuroglancer-annotation-multiple');
        }
      }
    }
    this.previousSelectedId = newSelectedId;
    if (!multiple) {
      const multiselected = Array.from(
          this.annotationListContainer.querySelectorAll('.neuroglancer-annotation-multiple'));
      multiselected.forEach(
          (e: HTMLElement) => e.classList.remove('neuroglancer-annotation-multiple'));
    }
  }

  private updateHoverView() {
    const selectedValue = this.annotationLayer.hoverState.value;
    let newHoverId: string|undefined;
    if (selectedValue !== undefined) {
      newHoverId = selectedValue.id;
    }
    const {previousHoverId} = this;
    if (newHoverId === previousHoverId) {
      return;
    }
    if (previousHoverId !== undefined) {
      const element = this.annotationListElements.get(previousHoverId);
      if (element !== undefined) {
        element.classList.remove('neuroglancer-annotation-hover');
      }
    }
    if (newHoverId !== undefined) {
      const element = this.annotationListElements.get(newHoverId);
      if (element !== undefined) {
        element.classList.add('neuroglancer-annotation-hover');
      }
    }
    this.previousHoverId = newHoverId;
  }

  private addAnnotationElementHelper(annotation: Annotation) {
    const {annotationLayer, annotationListContainer, annotationListElements} = this;
    const {objectToGlobal} = annotationLayer;

    const element = this.makeAnnotationListElement(annotation, objectToGlobal);
    if (element.dataset.parent) {
      const parent = annotationListContainer.querySelector(`[data-id="${element.dataset.parent}"]`);
      if (parent) {
        parent.appendChild(element);
      } else {
        // throw new Error(`Parent ${element.dataset.parent} does not exist`);
        // create virtual parent
        const childs = document.createElement('ul');
        childs.className = 'neuroglancer-annotation-children';
        childs.dataset.id = element.dataset.parent;
        childs.appendChild(element);
        annotationListContainer.appendChild(childs);
      }
    } else {
      annotationListContainer.appendChild(element);
    }
    annotationListElements.set(annotation.id, element);

    element.addEventListener('mouseenter', () => {
      this.annotationLayer.hoverState.value = {id: annotation.id, partIndex: 0};
    });
    element.addEventListener('click', (event: MouseEvent) => {
      if (event.ctrlKey || event.metaKey) {
        let multiple = new Set<string>();
        if (this.state.value) {
          if (this.state.value.multiple) {
            multiple = this.state.value.multiple;
          } else if (this.state.value.ungroupable) {
            // Cannot select line segment for group
          } else {
            multiple.add(this.state.value.id);
          }
        }
        multiple.add(annotation.id);
        this.state.value = {id: annotation.id, partIndex: 0, multiple};
      } else {
        this.state.value = {id: annotation.id, partIndex: 0};
      }
      event.stopPropagation();
    });

    element.addEventListener('mouseup', (event: MouseEvent) => {
      // TODO: Test on Mac, possibly same problem as creating annotation tab on mac
      if (event.button === 2) {
        if ((<Collection>annotation).entries) {
          (<Collection>annotation).cVis.value = !(<Collection>annotation).cVis.value;
          element.classList.toggle('neuroglancer-parent-viewable');
          this.annotationLayer.source.changed.dispatch();
        } else {
          // TODO: Fix this, need to center position without collapsing (fixed?)
          this.setSpatialCoordinates(
              getCenterPosition(annotation, this.annotationLayer.objectToGlobal));
        }
        event.stopPropagation();
      }
    });
  }

  private updateView() {
    if (!this.visible) {
      return;
    }
    if (this.updated) {
      return;
    }
    const {annotationLayer, annotationListContainer, annotationListElements} = this;
    const {source} = annotationLayer;
    removeChildren(annotationListContainer);
    annotationListElements.clear();
    for (const annotation of source) {
      this.addAnnotationElementHelper(annotation);
    }
    this.resetOnUpdate();
  }

  private addAnnotationElement(annotation: Annotation) {
    if (!this.visible) {
      return;
    }
    this.addAnnotationElementHelper(annotation);
    this.resetOnUpdate();
  }

  private updateAnnotationElement(annotation: Annotation, checkVisibility = true) {
    if (checkVisibility && !this.visible) {
      return;
    }
    var element = this.annotationListElements.get(annotation.id);
    if (!element) {
      return;
    }
    // FIXME: :scope is not supported in IE and Edge
    // https://stackoverflow.com/questions/52955799/scope-pseudo-selector-in-ms-edge
    {
      const position =
          <HTMLElement>element.querySelector(':scope > .neuroglancer-annotation-position');
      position.innerHTML = '';
      getPositionSummary(
          position, annotation, this.annotationLayer.objectToGlobal, this.voxelSize,
          this.setSpatialCoordinates);
    }
    const description =
        <HTMLElement>element.querySelector(':scope > .neuroglancer-annotation-description');
    if (description) {
      const annotationText = this.layer.getAnnotationText(annotation);
      if (!annotationText) {
        element.removeChild(description);
      } else {
        description.innerHTML = annotationText;
      }
    } else {
      this.createAnnotationDescriptionElement(element, annotation);
    }
    this.resetOnUpdate();
  }

  private deleteAnnotationElement(annotationId: string) {
    if (!this.visible) {
      return;
    }
    let element = this.annotationListElements.get(annotationId);
    if (element) {
      const children = element.querySelector('.neuroglancer-annotation-children');
      if (children) {
        // If there are children, move the child container
        element.removeChild(children!);
        if (children.children.length) {
          this.annotationListContainer.appendChild(children);
        }
      }

      removeFromParent(element);
      this.annotationListElements.delete(annotationId);
    }
    this.resetOnUpdate();
  }

  private resetOnUpdate() {
    this.previousSelectedId = undefined;
    this.previousHoverId = undefined;
    this.updated = true;
    this.updateHoverView();
    this.updateSelectionView();
  }

  private makeAnnotationListElement(annotation: Annotation, transform: mat4) {
    const element = document.createElement('li');
    element.title = 'Click to select, right click to recenter view.';

    const icon = document.createElement('div');
    icon.className = 'neuroglancer-annotation-icon';
    icon.textContent = getAnnotationTypeHandler(annotation.type).icon;
    element.appendChild(icon);

    const position = document.createElement('div');
    position.className = 'neuroglancer-annotation-position';
    getPositionSummary(position, annotation, transform, this.voxelSize, this.setSpatialCoordinates);
    element.appendChild(position);
    if (annotation.pid) {
      element.dataset.parent = annotation.pid;
    }
    this.createAnnotationDescriptionElement(element, annotation);
    if ((<Collection>annotation).entries) {
      // search for the child bin belonging to my ID
      const reclaim = this.annotationListContainer.querySelector(`[data-id="${annotation.id}"]`);
      if ((<Collection>annotation).cVis.value) {
        element.classList.add('neuroglancer-parent-viewable');
      }
      if (reclaim) {
        reclaim.parentElement!.removeChild(reclaim);
        element.appendChild(reclaim);
      } else {
        element.title = 'Click to select, right click to toggle children.';
        const childs = document.createElement('ul');
        childs.classList.add('neuroglancer-annotation-children');
        childs.dataset.id = annotation.id;
        element.appendChild(childs);
      }
    }

    return element;
  }

  private createAnnotationDescriptionElement(
      annotationElement: HTMLElement, annotation: Annotation) {
    const annotationText = this.layer.getAnnotationText(annotation);
    if (annotationText) {
      const description = document.createElement('div');
      description.className = 'neuroglancer-annotation-description';
      description.textContent = annotationText;
      annotationElement.appendChild(description);
    }
  }

  private filterAnnotationsByTag(tagId: number) {
    for (const [annotationId, annotationElement] of this.annotationListElements) {
      if (tagId === 0 ||
          this.annotationLayer.source.isAnnotationTaggedWithTag(annotationId, tagId)) {
        annotationElement.style.display = 'list-item';
      } else {
        annotationElement.style.display = 'none';
      }
    }
  }

  private exportToCSV() {
    const filename = 'annotations.csv';
    const pointToCoordinateText = (point: vec3, transform: mat4) => {
      const spatialPoint = vec3.transformMat4(vec3.create(), point, transform);
      return formatIntegerPoint(this.voxelSize.voxelFromSpatial(tempVec3, spatialPoint));
    };
    const columnHeaders = [
      'Coordinate 1', 'Coordinate 2', 'Ellipsoid Dimensions', 'Tags', 'Description', 'Segment IDs',
      'Parent ID', 'Type', 'ID'
    ];
    const csvData: string[][] = [];
    for (const annotation of this.annotationLayer.source) {
      const annotationRow = [];
      let coordinate1String = '';
      let coordinate2String = '';
      let ellipsoidDimensions = '';
      let stringType = '';
      let collectionID = '';
      switch (annotation.type) {
        case AnnotationType.AXIS_ALIGNED_BOUNDING_BOX:
        case AnnotationType.LINE:
          stringType = annotation.type === AnnotationType.LINE ? 'Line' : 'AABB';
          coordinate1String =
              pointToCoordinateText(annotation.pointA, this.annotationLayer.objectToGlobal);
          coordinate2String =
              pointToCoordinateText(annotation.pointB, this.annotationLayer.objectToGlobal);
          break;
        case AnnotationType.POINT:
          stringType = 'Point';
          coordinate1String =
              pointToCoordinateText(annotation.point, this.annotationLayer.objectToGlobal);
          break;
        case AnnotationType.ELLIPSOID:
          stringType = 'Ellipsoid';
          coordinate1String =
              pointToCoordinateText(annotation.center, this.annotationLayer.objectToGlobal);
          const transformedRadii = transformVectorByMat4(
              tempVec3, annotation.radii, this.annotationLayer.objectToGlobal);
          this.voxelSize.voxelFromSpatial(transformedRadii, transformedRadii);
          ellipsoidDimensions = formatIntegerBounds(transformedRadii);
          break;
        case AnnotationType.LINE_STRIP:
        case AnnotationType.COLLECTION:
          stringType = annotation.type === AnnotationType.LINE_STRIP ?
              ((<LineStrip>annotation).looped ? 'Line Strip*' : 'Line Strip') :
              'Collection';
          coordinate1String =
              pointToCoordinateText(annotation.source, this.annotationLayer.objectToGlobal);
          collectionID = annotation.id;
          break;
      }
      annotationRow.push(coordinate1String);
      annotationRow.push(coordinate2String);
      annotationRow.push(ellipsoidDimensions);
      // Tags
      if (this.annotationLayer.source instanceof AnnotationSource && annotation.tagIds) {
        // Papa.unparse expects an array of arrays even though here we only want to create a csv
        // for one row of tags
        const annotationTags: string[][] = [[]];
        annotation.tagIds.forEach(tagId => {
          const tag = (<AnnotationSource>this.annotationLayer.source).getTag(tagId);
          if (tag) {
            annotationTags[0].push(tag.label);
          }
        });
        if (annotationTags[0].length > 0) {
          annotationRow.push(Papa.unparse(annotationTags));
        } else {
          annotationRow.push('');
        }
      } else {
        annotationRow.push('');
      }
      // Description
      if (annotation.description) {
        annotationRow.push(annotation.description);
      } else {
        annotationRow.push('');
      }
      // Segment IDs
      if (annotation.segments) {
        // Papa.unparse expects an array of arrays even though here we only want to create a csv
        // for one row of segments
        const annotationSegments: string[][] = [[]];
        annotation.segments.forEach(segmentID => {
          annotationSegments[0].push(segmentID.toString());
        });
        if (annotationSegments[0].length > 0) {
          annotationRow.push(Papa.unparse(annotationSegments));
        } else {
          annotationRow.push('');
        }
      } else {
        annotationRow.push('');
      }
      // Parent ID
      annotationRow.push(annotation.pid || '');
      // Type
      annotationRow.push(stringType);
      // ID
      annotationRow.push(collectionID);

      csvData.push(annotationRow);
    }
    const csvString = Papa.unparse({'fields': columnHeaders, 'data': csvData});
    const blob = new Blob([csvString], {type: 'text/csv;charset=utf-8;'});
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  // TODO: pull request to papa repo
  private betterPapa = (inputFile: File|Blob): Promise<any> => {
    return new Promise((resolve) => {
      Papa.parse(inputFile, {
        complete: (results: any) => {
          resolve(results);
        }
      });
    });
  }

  private stringToVec3 = (input: string): vec3 => {
    // format: (x, y, z)
    let raw = input.split('');
    raw.shift();
    raw.pop();
    let list = raw.join('');
    let val = list.split(',').map(v => parseInt(v, 10));
    return vec3.fromValues(val[0], val[1], val[2]);
  }

  private async importCSV(files: FileList|null) {
    const rawAnnotations = <Annotation[]>[];
    let successfulImport = 0;

    if (!files) {
      return;
    }

    for (const file of files) {
      const rawData = await this.betterPapa(file);
      rawData.data.shift();
      rawData.data = rawData.data.filter((v: any) => v.join('').length);
      if (!rawData.data.length) {
        continue;
      }
      const annStrings = rawData.data;
      annStrings.shift();
      const registry = <any>{};
      for (const annProps of annStrings) {
        const type = annProps[7];
        const pid = annProps[6];
        const cid = annProps[8];
        const tags = annProps[3];
        let raw = <Annotation><any>{id: makeAnnotationId(), description: annProps[4]};

        if (cid) {
          if (!registry[cid]) {
            registry[cid] = raw;
            (<Collection>raw).entries = [];
          } else {
            raw = {...raw, ...registry[cid]};
            registry[cid] = raw;
            (<Collection>raw).entries.forEach((ann: any) => {
              ann.pid = raw.id;
              return ann.id;
            });
          }
        }
        if (pid) {
          if (registry[pid]) {
            const parent = registry[pid];
            if (parent.id) {
              parent.entries.push(raw.id);
              raw.pid = parent.id;
            } else {
              parent.entries.push(raw);
            }
          } else {
            registry[pid] = {entries: [raw]};
          }
        }
        if (tags) {
          raw.tagIds = new Set();
          const labels = tags.split(',');
          const alayer = (<AnnotationSource>this.annotationLayer.source);
          const currentTags = Array.from(alayer.getTags());
          labels.forEach((label: string) => {
            const tagId = (currentTags.find(tag => tag.label === label) || <any>{}).id ||
                alayer.addTag(label);
            raw.tagIds!.add(tagId);
          });
        }
        // TODO: Is this transferable?
        // raw.segments = getSelectedAssocatedSegment(annotationLayer),

        switch (type) {
          case 'AABB':
          case 'Line':
            raw.type =
                type === 'Line' ? AnnotationType.LINE : AnnotationType.AXIS_ALIGNED_BOUNDING_BOX;
            (<Line>raw).pointA = vec3.transformMat4(
                vec3.create(), this.stringToVec3(annProps[0]), this.annotationLayer.globalToObject);
            (<Line>raw).pointB = vec3.transformMat4(
                vec3.create(), this.stringToVec3(annProps[1]), this.annotationLayer.globalToObject);
            break;
          case 'Point':
            raw.type = AnnotationType.POINT;
            (<Point>raw).point = vec3.transformMat4(
                vec3.create(), this.stringToVec3(annProps[0]), this.annotationLayer.globalToObject);
            break;
          case 'Ellipsoid':
            raw.type = AnnotationType.ELLIPSOID;
            (<Ellipsoid>raw).center = vec3.transformMat4(
                vec3.create(), this.stringToVec3(annProps[0]), this.annotationLayer.globalToObject);
            // TODO: Check that this is correct
            (<Ellipsoid>raw).radii = vec3.transformMat4(
                vec3.create(), this.stringToVec3(annProps[2]), this.annotationLayer.globalToObject);
            break;
          case 'Line Strip':
          case 'Line Strip*':
          case 'Collection':
            if (type === 'Line Strip' || type === 'Line Strip*') {
              raw.type = AnnotationType.LINE_STRIP;
              (<LineStrip>raw).connected = true;
              (<LineStrip>raw).looped = type === 'Line Strip*';
            } else {
              raw.type = AnnotationType.COLLECTION;
              (<Collection>raw).connected = false;
            }
            (<Collection>raw).cVis = new TrackableBoolean(false, true);
            (<Collection>raw).source = vec3.transformMat4(
                vec3.create(), this.stringToVec3(annProps[0]), this.annotationLayer.globalToObject);
            (<Collection>raw).entry = (index: number) =>
                (<LocalAnnotationSource>this.annotationLayer.source)
                    .get((<Collection>raw).entries[index]);
            break;
        }

        rawAnnotations.push(raw);
      }
      successfulImport++;
    }

    for (const annotation of rawAnnotations) {
      this.annotationLayer.source.add(annotation, /*commit=*/true);
    }
    // TODO: Undoable
    StatusMessage.showTemporaryMessage(`Imported ${successfulImport} csv(s).`, 3000);
  }
}

export class AnnotationDetailsTab extends Tab {
  private valid = false;
  private mouseEntered = false;
  private hoverState: WatchableValue<{id: string, partIndex?: number}|undefined>|undefined;
  private segmentListWidget: AnnotationSegmentListWidget|undefined;
  constructor(
      public state: Owned<SelectedAnnotationState>, public voxelSize: VoxelSize,
      public setSpatialCoordinates: (point: vec3) => void) {
    super();
    this.element.classList.add('neuroglancer-annotation-details');
    this.registerDisposer(state);
    this.registerDisposer(voxelSize);
    this.registerDisposer(this.state.changed.add(() => {
      this.valid = false;
      this.updateView();
    }));
    this.registerDisposer(this.visibility.changed.add(() => this.updateView()));
    this.state.changed.add(() => {
      this.valid = false;
      this.updateView();
    });
    this.element.addEventListener('mouseenter', () => {
      this.mouseEntered = true;
      if (this.hoverState !== undefined) {
        this.hoverState.value = this.state.value;
      }
    });
    this.element.addEventListener('mouseleave', () => {
      this.mouseEntered = false;
      if (this.hoverState !== undefined) {
        this.hoverState.value = undefined;
      }
    });
    this.updateView();
  }

  private updateView() {
    if (!this.visible) {
      this.element.style.display = 'none';
      this.hoverState = undefined;
      return;
    }
    this.element.style.display = null;
    if (this.valid) {
      return;
    }
    const {element} = this;
    removeChildren(element);
    this.valid = true;
    const {reference} = this.state;
    if (reference === undefined) {
      return;
    }
    const value = this.state.value!;
    const annotation = reference.value;
    if (annotation == null) {
      return;
    }
    const annotationLayer = this.state.annotationLayerState.value!;
    this.hoverState = annotationLayer.hoverState;
    if (this.mouseEntered) {
      this.hoverState.value = value;
    }

    const {objectToGlobal} = annotationLayer;
    const {voxelSize} = this;

    const handler = getAnnotationTypeHandler(annotation.type);

    const title = document.createElement('div');
    title.className = 'neuroglancer-annotation-details-title';

    const icon = document.createElement('div');
    icon.className = 'neuroglancer-annotation-details-icon';
    icon.textContent = handler.icon;

    const titleText = document.createElement('div');
    titleText.className = 'neuroglancer-annotation-details-title-text';
    titleText.textContent = `${handler.description}`;
    title.appendChild(icon);
    title.appendChild(titleText);

    let isLineSegment: boolean|undefined;
    let isChild: boolean|undefined;
    let isSingleton: boolean|undefined;
    // TODO: MultiScaleAnnotationSource
    let isInProgress = (<AnnotationSource>annotationLayer.source).isPending(value.id);
    let parent: Collection|undefined;

    const ann = annotationLayer.source.getReference(value.id).value!;
    const parref = ann.pid ? annotationLayer.source.getReference(ann.pid) : null;

    if (ann.pid && parref && parref.value) {
      // set child like properties
      parent = <Collection>parref.value;
      isLineSegment = parent.type === AnnotationType.LINE_STRIP;
      isChild = true;
      isSingleton = (parent.entries.length === 1);
    }
    if (isLineSegment) {
      titleText.textContent = 'Line (segment)';
      // not allowed to multi select line segments
      value.multiple = void (0);
      value.ungroupable = true;
    }
    if (isInProgress) {
      // TODO: Reset details layer value on annotation completion/ or just call dispatch for update
      // view
      titleText.textContent = `${titleText.textContent} (in progress)`;
      // not allowed to multi select line segments
      value.multiple = void (0);
      value.ungroupable = true;
    }
    if (value.multiple) {
      titleText.textContent = `${value.multiple.size} annotations selected`;
      icon.textContent = '~';
    }
    if (!annotationLayer.source.readonly && !isLineSegment && !isInProgress) {
      // Evict
      if (isChild && !value.multiple) {
        const evictButton = makeTextIconButton('✂️', 'Remove from collection');
        evictButton.addEventListener('click', () => {
          const parent_ref = annotationLayer.source.getReference(ann.pid!);
          if (isSingleton) {
            // DRY: ungroup
            try {
              annotationLayer.source.delete(parent_ref);
            } finally {
              parent_ref.dispose();
            }
          } else {
            (<AnnotationSource>annotationLayer.source).cps([ann.id]);
          }
          this.state.value = void (0);
        });
        title.appendChild(evictButton);
      }
      // Group
      {
        const groupButton = makeTextIconButton('⚄', 'Create collection');
        groupButton.addEventListener('click', () => {
          // Create a new collection with annotations in value.multiple
          let target: string[];
          if (value.multiple) {
            target = Array.from(value.multiple);
          } else {
            target = [value.id];
          }
          const first = annotationLayer.source.getReference(target[0]).value!;
          let srcpt;
          switch (first.type) {
            case AnnotationType.AXIS_ALIGNED_BOUNDING_BOX:
            case AnnotationType.LINE:
              srcpt = (<Line|AxisAlignedBoundingBox>first).pointA;
              break;
            case AnnotationType.POINT:
              srcpt = (<Point>first).point;
              break;
            case AnnotationType.ELLIPSOID:
              srcpt = (<Ellipsoid>first).center;
              break;
            case AnnotationType.LINE_STRIP:
            case AnnotationType.COLLECTION:
              srcpt = (<LineStrip>first).source;
              break;
          }

          const coll = <Collection>{
            id: '',
            type: AnnotationType.COLLECTION,
            description: '',
            entries: [],  // identical totarget
            segments: [],
            connected: false,
            source: srcpt,
            entry: () => {},
            cVis: new TrackableBoolean(true, true)
          };
          coll.entry = (index: number) =>
              (<LocalAnnotationSource>annotationLayer.source).get(coll.entries[index]);

          const ref = (<AnnotationSource>annotationLayer.source).add(coll, true);
          if (first.pid) {
            const firstParent = (<AnnotationSource>annotationLayer.source).getReference(first.pid);
            (<AnnotationSource>annotationLayer.source).cps([ref.value!.id], firstParent);
          }
          const emptyColl = (<AnnotationSource>annotationLayer.source).cps(target, ref);

          // It shouldn't be possible for a collection to be empty twice, that is the child says the
          // parent is empty and then a subsequent child says the same
          emptyColl.forEach((reff: AnnotationReference) => {
            try {
              // Delete annotation and all its children
              annotationLayer.source.delete(reff);
            } finally {
              reff.dispose();
            }
          });
          this.state.value = {id: ref.id};
        });
        title.appendChild(groupButton);
      }
      // Ungroup
      if ((ann.type === AnnotationType.COLLECTION || ann.type === AnnotationType.LINE_STRIP) &&
          !value.multiple) {
        const ungroupButton = makeTextIconButton('💥', 'Free annotations');
        ungroupButton.addEventListener('click', () => {
          // Delete annotation and send its children to an ancestor or root
          // TODO: works partially but need to recreate parent element
          const ref = annotationLayer.source.getReference(value.id);
          try {
            annotationLayer.source.delete(ref);
          } finally {
            ref.dispose();
          }
        });
        title.appendChild(ungroupButton);
      }
      // Delete
      {
        const deleteButton = makeTextIconButton('🗑', 'Delete annotation');
        deleteButton.addEventListener('click', () => {
          let target: string[];
          if (value.multiple) {
            target = Array.from(value.multiple);
          } else {
            target = [value.id];
          }
          target.forEach((id: string) => {
            const ref = annotationLayer.source.getReference(id);
            try {
              // Delete annotation and all its children
              annotationLayer.source.delete(ref, true);
            } finally {
              ref.dispose();
            }
          });
        });
        title.appendChild(deleteButton);
      }
    }

    const closeButton = makeCloseButton();
    closeButton.title = 'Hide annotation details';
    closeButton.addEventListener('click', () => {
      this.state.value = undefined;
    });
    title.appendChild(closeButton);

    element.appendChild(title);

    if (!value.multiple) {
      const position = document.createElement('div');
      position.className = 'neuroglancer-annotation-details-position';
      getPositionSummary(
          position, annotation, objectToGlobal, voxelSize, this.setSpatialCoordinates);
      element.appendChild(position);

      if (annotation.type === AnnotationType.AXIS_ALIGNED_BOUNDING_BOX) {
        const volume = document.createElement('div');
        volume.className = 'neuroglancer-annotation-details-volume';
        volume.textContent =
            formatBoundingBoxVolume(annotation.pointA, annotation.pointB, objectToGlobal);
        element.appendChild(volume);

        // FIXME: only do this if it is axis aligned
        const spatialOffset = transformVectorByMat4(
            tempVec3, vec3.subtract(tempVec3, annotation.pointA, annotation.pointB),
            objectToGlobal);
        const voxelVolume = document.createElement('div');
        voxelVolume.className = 'neuroglancer-annotation-details-volume-in-voxels';
        const voxelOffset = voxelSize.voxelFromSpatial(tempVec3, spatialOffset);
        voxelVolume.textContent = `${formatIntegerBounds(voxelOffset)}`;
        element.appendChild(voxelVolume);
      } else if (annotation.type === AnnotationType.LINE) {
        const spatialOffset = transformVectorByMat4(
            tempVec3, vec3.subtract(tempVec3, annotation.pointA, annotation.pointB),
            objectToGlobal);
        const length = document.createElement('div');
        length.className = 'neuroglancer-annotation-details-length';
        const spatialLengthText = formatLength(vec3.length(spatialOffset));
        let voxelLengthText = '';
        if (voxelSize.valid) {
          const voxelLength = vec3.length(voxelSize.voxelFromSpatial(tempVec3, spatialOffset));
          voxelLengthText = `, ${Math.round(voxelLength)} vx`;
        }
        length.textContent = spatialLengthText + voxelLengthText;
        element.appendChild(length);
      }
    }

    let {segmentListWidget} = this;
    if (segmentListWidget !== undefined) {
      if (segmentListWidget.reference !== reference) {
        segmentListWidget.dispose();
        this.unregisterDisposer(segmentListWidget);
        segmentListWidget = this.segmentListWidget = undefined;
      }
    }
    if (segmentListWidget === undefined) {
      this.segmentListWidget = segmentListWidget =
          this.registerDisposer(new AnnotationSegmentListWidget(reference, annotationLayer));
    }
    element.appendChild(segmentListWidget.element);

    if (!value.multiple) {
      const description = document.createElement('textarea');
      description.value = annotation.description || '';
      description.rows = 3;
      description.className = 'neuroglancer-annotation-details-description';
      description.placeholder = 'Description';
      if (annotationLayer.source.readonly) {
        description.readOnly = true;
      } else {
        description.addEventListener('change', () => {
          const x = description.value;
          annotationLayer.source.update(reference, {...annotation, description: x ? x : undefined});
          annotationLayer.source.commit(reference);
        });
      }
      element.appendChild(description);
    }
  }
}

export class AnnotationTab extends Tab {
  private stack = this.registerDisposer(
      new StackView<AnnotationLayerState, AnnotationLayerView>(annotationLayerState => {
        return new AnnotationLayerView(
            this.layer, this.state.addRef(), annotationLayerState.addRef(), this.voxelSize.addRef(),
            this.setSpatialCoordinates);
      }, this.visibility));
  private detailsTab = this.registerDisposer(
      new AnnotationDetailsTab(this.state, this.voxelSize.addRef(), this.setSpatialCoordinates));
  constructor(
      public layer: Borrowed<UserLayerWithAnnotations>,
      public state: Owned<SelectedAnnotationState>, public voxelSize: Owned<VoxelSize>,
      public setSpatialCoordinates: (point: vec3) => void) {
    super();
    this.registerDisposer(state);
    this.registerDisposer(voxelSize);
    const {element} = this;
    element.classList.add('neuroglancer-annotations-tab');
    this.stack.element.classList.add('neuroglancer-annotations-stack');
    element.appendChild(this.stack.element);
    element.appendChild(this.detailsTab.element);
    const updateDetailsVisibility = () => {
      this.detailsTab.visibility.value = this.state.validValue !== undefined && this.visible ?
          WatchableVisibilityPriority.VISIBLE :
          WatchableVisibilityPriority.IGNORED;
    };
    this.registerDisposer(this.state.changed.add(updateDetailsVisibility));
    this.registerDisposer(this.visibility.changed.add(updateDetailsVisibility));
    const setAnnotationLayerView = () => {
      this.stack.selected = this.state.annotationLayerState.value;
    };
    this.registerDisposer(this.state.annotationLayerState.changed.add(setAnnotationLayerView));
    setAnnotationLayerView();
  }
}

function getSelectedAssocatedSegment(annotationLayer: AnnotationLayerState) {
  let segments: Uint64[]|undefined;
  const segmentationState = annotationLayer.segmentationState.value;
  if (segmentationState != null) {
    if (segmentationState.segmentSelectionState.hasSelectedSegment) {
      segments = [segmentationState.segmentSelectionState.selectedSegment.clone()];
    }
  }
  return segments;
}

abstract class PlaceAnnotationTool extends Tool {
  temp?: Annotation;
  group: string;
  annotationDescription: string|undefined;
  annotationType: AnnotationType.POINT|AnnotationType.LINE|
      AnnotationType.AXIS_ALIGNED_BOUNDING_BOX|AnnotationType.ELLIPSOID|
      AnnotationType.COLLECTION|AnnotationType.LINE_STRIP;
  constructor(public layer: UserLayerWithAnnotations, options: any) {
    super();
    if (layer.annotationLayerState === undefined) {
      throw new Error(`Invalid layer for annotation tool.`);
    }
    this.annotationDescription = verifyObjectProperty(options, 'description', verifyOptionalString);
  }

  get annotationLayer() {
    return this.layer.annotationLayerState.value;
  }

  complete() {
    StatusMessage.showTemporaryMessage(`Only supported in collection annotations.`, 3000);
  }
}

const ANNOTATE_POINT_TOOL_ID = 'annotatePoint';
const ANNOTATE_LINE_TOOL_ID = 'annotateLine';
const ANNOTATE_COLLECTION_TOOL_ID = 'annotateCollection';
const ANNOTATE_LINE_STRIP_TOOL_ID = 'annotateLineStrip';
const ANNOTATE_BOUNDING_BOX_TOOL_ID = 'annotateBoundingBox';
const ANNOTATE_ELLIPSOID_TOOL_ID = 'annotateSphere';

export class PlacePointTool extends PlaceAnnotationTool {
  annotationType: AnnotationType.POINT;
  constructor(layer: UserLayerWithAnnotations, options: any) {
    super(layer, options);
  }

  trigger(mouseState: MouseSelectionState, parentRef?: AnnotationReference) {
    const {annotationLayer} = this;
    if (annotationLayer === undefined) {
      // Not yet ready.
      return;
    }
    if (mouseState.active) {
      const annotation: Annotation = {
        id: '',
        description: '',
        segments: getSelectedAssocatedSegment(annotationLayer),
        point:
            vec3.transformMat4(vec3.create(), mouseState.position, annotationLayer.globalToObject),
        type: AnnotationType.POINT,
      };
      if (parentRef) {
        annotation.pid = parentRef.id;
      }
      const reference = annotationLayer.source.add(annotation, /*commit=*/true);
      this.layer.selectedAnnotation.value = {id: reference.id};
      if (parentRef) {
        const parent = (<Collection>parentRef.value!);
        parent.entries.push(reference.id);
        if (parent.segments && annotation.segments) {
          parent.segments = [...parent.segments!, ...annotation.segments!];
        }
      }
      reference.dispose();
    }
  }

  get description() {
    return `annotate point`;
  }

  toJSON() {
    return ANNOTATE_POINT_TOOL_ID;
  }
}

function getMousePositionInAnnotationCoordinates(
    mouseState: MouseSelectionState, annotationLayer: AnnotationLayerState) {
  return vec3.transformMat4(vec3.create(), mouseState.position, annotationLayer.globalToObject);
}

abstract class TwoStepAnnotationTool extends PlaceAnnotationTool {
  inProgressAnnotation:
      {annotationLayer: AnnotationLayerState, reference: AnnotationReference, disposer: () => void}|
      undefined;

  abstract getInitialAnnotation(
      mouseState: MouseSelectionState, annotationLayer: AnnotationLayerState): Annotation;
  abstract getUpdatedAnnotation(
      oldAnnotation: Annotation, mouseState: MouseSelectionState,
      annotationLayer: AnnotationLayerState): Annotation;

  trigger(mouseState: MouseSelectionState, parentRef?: AnnotationReference) {
    const {annotationLayer} = this;
    if (annotationLayer === undefined) {
      // Not yet ready.
      return;
    }
    if (mouseState.active) {
      const updatePointB = () => {
        const state = this.inProgressAnnotation!;
        const reference = state.reference;
        const newAnnotation =
            this.getUpdatedAnnotation(reference.value!, mouseState, annotationLayer);
        state.annotationLayer.source.update(reference, newAnnotation);
        this.layer.selectedAnnotation.value = {id: reference.id};
      };

      if (this.inProgressAnnotation === undefined) {
        const annotation = this.getInitialAnnotation(mouseState, annotationLayer);
        if (parentRef) {
          annotation.pid = parentRef.id;
        }
        const reference = annotationLayer.source.add(annotation, /*commit=*/false);
        if (parentRef) {
          const parent = (<Collection>parentRef.value!);
          parent.entries.push(reference.id);
          if (parent.segments && annotation.segments) {
            parent.segments = [...parent.segments!, ...annotation.segments!];
          }
        }
        this.layer.selectedAnnotation.value = {id: reference.id};
        const disposer = () => {
          mouseDisposer();
          reference.dispose();
        };
        this.inProgressAnnotation = {
          annotationLayer,
          reference,
          disposer,
        };
        const mouseDisposer = mouseState.changed.add(updatePointB);
      } else {
        updatePointB();
        if (this.inProgressAnnotation) {
          this.inProgressAnnotation.annotationLayer.source.commit(
              this.inProgressAnnotation.reference);
          this.inProgressAnnotation.disposer();
          this.inProgressAnnotation = undefined;
          this.layer.selectedAnnotation.changed.dispatch();
        }
      }
    }
  }

  disposed() {
    this.deactivate();
    super.disposed();
  }

  deactivate() {
    if (this.inProgressAnnotation !== undefined) {
      this.inProgressAnnotation.annotationLayer.source.delete(this.inProgressAnnotation.reference);
      this.inProgressAnnotation.disposer();
      this.inProgressAnnotation = undefined;
    }
  }
}

abstract class PlaceTwoCornerAnnotationTool extends TwoStepAnnotationTool {
  annotationType: AnnotationType.LINE|AnnotationType.AXIS_ALIGNED_BOUNDING_BOX;

  getInitialAnnotation(mouseState: MouseSelectionState, annotationLayer: AnnotationLayerState):
      Annotation {
    const point = getMousePositionInAnnotationCoordinates(mouseState, annotationLayer);
    return <AxisAlignedBoundingBox|Line>{
      id: '',
      type: this.annotationType,
      description: '',
      pointA: point,
      pointB: point,
    };
  }

  getUpdatedAnnotation(
      oldAnnotation: AxisAlignedBoundingBox|Line, mouseState: MouseSelectionState,
      annotationLayer: AnnotationLayerState): Annotation {
    const point = getMousePositionInAnnotationCoordinates(mouseState, annotationLayer);
    return {...oldAnnotation, pointB: point};
  }
}

export class MultiStepAnnotationTool extends PlaceAnnotationTool {
  inProgressAnnotation:
      {annotationLayer: AnnotationLayerState, reference: AnnotationReference, disposer: () => void}|
      undefined;
  annotationType: AnnotationType.COLLECTION|AnnotationType.LINE_STRIP;
  toolset: MultiTool;
  toolbox: HTMLDivElement;
  childTool: PlacePointTool|PlaceBoundingBoxTool|PlaceLineTool|PlaceSphereTool|PlaceLineStripTool|
      undefined;
  constructor(public layer: UserLayerWithAnnotations, options: any) {
    super(layer, options);
    this.toolbox = options.toolbox;
  }

  getInitialAnnotation(mouseState: MouseSelectionState, annotationLayer: AnnotationLayerState):
      Annotation {
    const coll = <Collection>{
      id: '',
      type: this.annotationType,
      description: '',
      entries: [],
      segments: [],
      connected: false,
      source:
          vec3.transformMat4(vec3.create(), mouseState.position, annotationLayer.globalToObject),
      entry: () => {},
      cVis: new TrackableBoolean(true, true)
    };
    coll.entry = (index: number) =>
        (<LocalAnnotationSource>annotationLayer.source).get(coll.entries[index]);
    return coll;
  }
  complete() {
    if ((this.inProgressAnnotation && this.childTool) ||
        (this.inProgressAnnotation && this.inProgressAnnotation!.reference.value! &&
         (<Collection>this.inProgressAnnotation!.reference.value!).entries.length)) {
      const childInProgress = this.childTool ?
          (<MultiStepAnnotationTool|TwoStepAnnotationTool>this.childTool!).inProgressAnnotation :
          void (0);
      const childCount = (<Collection>this.inProgressAnnotation!.reference.value!).entries.length;
      if (this.childTool && (<PlaceLineStripTool>this.childTool!).toolset) {
        if ((<LineStrip>childInProgress!.reference.value!).entries.length > 1) {
          this.childTool!.complete();
          this.childTool!.dispose();
          StatusMessage.showTemporaryMessage(
              `Child annotation ${childInProgress!.reference.value!.id} complete.`);
          this.childTool = undefined;
          this.layer.tool.changed.dispatch();
          this.layer.selectedAnnotation.changed.dispatch();

          let key = this.toolbox.querySelector('.neuroglancer-child-collection-tool');
          if (key) {
            key.classList.remove('neuroglancer-child-collection-tool');
          }
        } else {
          // see line 1960
          StatusMessage.showTemporaryMessage(`No annotation has been made.`, 3000);
        }
      } else if ((!childInProgress && childCount === 1) || childCount > 1) {
        if (this.childTool) {
          this.childTool!.dispose();
        }
        this.inProgressAnnotation!.annotationLayer.source.commit(
            this.inProgressAnnotation!.reference);
        StatusMessage.showTemporaryMessage(
            `Annotation ${this.inProgressAnnotation!.reference.value!.id} complete.`);
        this.inProgressAnnotation!.disposer();
        this.inProgressAnnotation = undefined;
        this.layer.selectedAnnotation.changed.dispatch();
      } else {
        StatusMessage.showTemporaryMessage(`No annotation has been made.`, 3000);
      }
    } else {
      // if child tool has a toolset, its a lineStrip, and we apply the lineStrip test b4
      // continuing if child tool is a base annotation, it must have at least one complete
      // annotation an annotation is complete if the child tool has no inProgressAnnotation if
      // there are more than two annotations in entries, the first one is guaranteed to be
      // complete
      StatusMessage.showTemporaryMessage(`No annotation has been made.`, 3000);
    }
  }

  trigger(mouseState: MouseSelectionState, parentRef?: AnnotationReference) {
    const {annotationLayer} = this;
    if (annotationLayer === undefined) {
      // Not yet ready.
      return;
    }
    if (!this.childTool) {
      StatusMessage.showTemporaryMessage(`Collections require a child tool.`);
      return;
    }
    if (mouseState.active) {
      if (this.inProgressAnnotation === undefined) {
        const annotation = this.getInitialAnnotation(mouseState, annotationLayer);
        if (parentRef) {
          annotation.pid = parentRef.id;
        }
        const reference = annotationLayer.source.add(annotation, /*commit=*/false);
        if (parentRef) {
          const parent = (<Collection>parentRef.value!);
          parent.entries.push(reference.id);
          if (parent.segments && annotation.segments) {
            parent.segments = [...parent.segments!, ...annotation.segments!];
          }
        }
        this.layer.selectedAnnotation.value = {id: reference.id};
        this.childTool.trigger(mouseState, /*child=*/reference);
        const disposer = () => {
          mouseDisposer();
          reference.dispose();
        };
        this.inProgressAnnotation = {
          annotationLayer,
          reference,
          disposer,
        };
        const mouseDisposer = () => {};
      } else {
        this.childTool.trigger(mouseState, this.inProgressAnnotation.reference);
      }
    }
  }

  get description() {
    return `annotate collection: ${
        this.childTool ? this.childTool.description : 'no child tool selected'}`;
  }

  toJSON() {
    return ANNOTATE_COLLECTION_TOOL_ID;
  }

  dispose() {
    if (this.childTool) {
      this.childTool!.dispose();
    }
    if (this.inProgressAnnotation) {
      // completely delete the annotation
      const annotation_ref = this.inProgressAnnotation.reference;
      this.annotationLayer!.source.delete(annotation_ref, true);
      //  childDeleted.dispatch(annotation_ref.value!.id);
      this.inProgressAnnotation!.disposer();
    }
    super.dispose();
  }
}
MultiStepAnnotationTool.prototype.annotationType = AnnotationType.COLLECTION;

export class PlaceLineStripTool extends MultiStepAnnotationTool {
  annotationType: AnnotationType.LINE_STRIP;
  toolset = PlaceLineTool;
  looped = false;
  initMouseState: MouseSelectionState;
  initPos: any;
  constructor(public layer: UserLayerWithAnnotations, options: any) {
    super(layer, options);
    this.childTool = new this.toolset(layer, options);
    this.toolbox = options.toolbox;
    if (this.toolbox.querySelector('.neuroglancer-linestrip-looped')) {
      this.looped = true;
    }
  }

  getInitialAnnotation(mouseState: MouseSelectionState, annotationLayer: AnnotationLayerState):
      Annotation {
    const result = <LineStrip>super.getInitialAnnotation(mouseState, annotationLayer);
    result.connected = true;
    result.looped = this.looped;
    result.type = this.annotationType;
    return result;
  }

  initChildAnnotation() {
    if (!(this.childTool instanceof PlacePointTool)) {
      const inProgressAnnotation = (<TwoStepAnnotationTool>this.childTool).inProgressAnnotation;
      // Child should not be a collection (for now)
      const child = inProgressAnnotation!.reference;
      const disposer = inProgressAnnotation!.disposer;
      inProgressAnnotation!.disposer = () => {
        // for every child annotation, redefine its disposer to call the parent to push to the
        // entry list
        disposer();
      };
      return child;
    }
    return;
  }

  appendNewChildAnnotation(oldAnnotationRef: AnnotationReference, mouseState: MouseSelectionState):
      Annotation {
    const oldAnnotation = <Collection>oldAnnotationRef!.value!;
    this.childTool = new this.toolset(this.layer, {});
    this.childTool.trigger(mouseState, oldAnnotationRef);

    let last = this.initChildAnnotation();
    return {...oldAnnotation, last};
  }

  trigger(mouseState: MouseSelectionState, parentRef?: AnnotationReference) {
    if (mouseState.active) {
      if (this.inProgressAnnotation === undefined) {
        this.initMouseState = <MouseSelectionState>{...mouseState};
        this.initPos = mouseState.position.slice();
        super.trigger(mouseState, parentRef);
      } else {
        super.trigger(mouseState, parentRef);
        // Start new annotation automatically
        this.appendNewChildAnnotation(this.inProgressAnnotation.reference!, mouseState);
      }
    }
  }

  complete() {
    if (this.inProgressAnnotation) {
      const innerEntries = (<LineStrip>this.inProgressAnnotation!.reference.value!).entries;
      if (innerEntries.length > 1) {
        if (this.looped) {
          const fakeMouse = <MouseSelectionState>{...this.initMouseState, position: this.initPos};
          (<LineStrip>this.inProgressAnnotation!.reference.value!).looped = true;
          this.childTool!.trigger(fakeMouse, this.inProgressAnnotation!.reference);
        }
        super.complete();
      } else {
        // for LineStrip, a second annotation is created automatically after the first is done
        // if entries.length is less than 2, the first annotation is not confirmed
        StatusMessage.showTemporaryMessage(`No annotation has been made.`, 3000);
      }
    }
  }

  get description() {
    return `annotate line strip ${this.looped ? '(loop)' : ''}`;
  }

  toJSON() {
    return ANNOTATE_LINE_STRIP_TOOL_ID;
  }
}
PlaceLineStripTool.prototype.annotationType = AnnotationType.LINE_STRIP;

export class PlaceBoundingBoxTool extends PlaceTwoCornerAnnotationTool {
  get description() {
    return `annotate bounding box`;
  }

  toJSON() {
    return ANNOTATE_BOUNDING_BOX_TOOL_ID;
  }
}
PlaceBoundingBoxTool.prototype.annotationType = AnnotationType.AXIS_ALIGNED_BOUNDING_BOX;

export class PlaceLineTool extends PlaceTwoCornerAnnotationTool {
  get description() {
    return `annotate line`;
  }

  getInitialAnnotation(mouseState: MouseSelectionState, annotationLayer: AnnotationLayerState):
      Annotation {
    const result = super.getInitialAnnotation(mouseState, annotationLayer);
    result.segments = getSelectedAssocatedSegment(annotationLayer);
    return result;
  }

  getUpdatedAnnotation(
      oldAnnotation: Line|AxisAlignedBoundingBox, mouseState: MouseSelectionState,
      annotationLayer: AnnotationLayerState) {
    const result = super.getUpdatedAnnotation(oldAnnotation, mouseState, annotationLayer);
    const segments = result.segments;
    if (segments !== undefined && segments.length > 0) {
      segments.length = 1;
    }
    let newSegments = getSelectedAssocatedSegment(annotationLayer);
    if (newSegments && segments) {
      newSegments = newSegments.filter(x => segments.findIndex(y => Uint64.equal(x, y)) === -1);
    }
    result.segments = [...(segments || []), ...(newSegments || [])] || undefined;
    return result;
  }

  toJSON() {
    return ANNOTATE_LINE_TOOL_ID;
  }
}
PlaceLineTool.prototype.annotationType = AnnotationType.LINE;

class PlaceSphereTool extends TwoStepAnnotationTool {
  getInitialAnnotation(mouseState: MouseSelectionState, annotationLayer: AnnotationLayerState):
      Annotation {
    const point = getMousePositionInAnnotationCoordinates(mouseState, annotationLayer);

    return <Ellipsoid>{
      type: AnnotationType.ELLIPSOID,
      id: '',
      description: '',
      segments: getSelectedAssocatedSegment(annotationLayer),
      center: point,
      radii: vec3.fromValues(0, 0, 0),
    };
  }

  getUpdatedAnnotation(
      oldAnnotation: Ellipsoid, mouseState: MouseSelectionState,
      annotationLayer: AnnotationLayerState) {
    const spatialCenter =
        vec3.transformMat4(vec3.create(), oldAnnotation.center, annotationLayer.objectToGlobal);

    const radius = vec3.distance(spatialCenter, mouseState.position);

    const tempMatrix = mat3.create();
    tempMatrix[0] = tempMatrix[4] = tempMatrix[8] = 1 / (radius * radius);


    const objectToGlobalLinearTransform =
        mat3FromMat4(mat3.create(), annotationLayer.objectToGlobal);
    mat3.multiply(tempMatrix, tempMatrix, objectToGlobalLinearTransform);
    mat3.transpose(objectToGlobalLinearTransform, objectToGlobalLinearTransform);
    mat3.multiply(tempMatrix, objectToGlobalLinearTransform, tempMatrix);

    return <Ellipsoid>{
      ...oldAnnotation,
      radii: vec3.fromValues(
          1 / Math.sqrt(tempMatrix[0]), 1 / Math.sqrt(tempMatrix[4]), 1 / Math.sqrt(tempMatrix[8])),
    };
  }
  get description() {
    return `annotate ellipsoid`;
  }

  toJSON() {
    return ANNOTATE_ELLIPSOID_TOOL_ID;
  }
}

registerTool(
    ANNOTATE_POINT_TOOL_ID,
    (layer, options) => new PlacePointTool(<UserLayerWithAnnotations>layer, options));
registerTool(
    ANNOTATE_BOUNDING_BOX_TOOL_ID,
    (layer, options) => new PlaceBoundingBoxTool(<UserLayerWithAnnotations>layer, options));
registerTool(
    ANNOTATE_LINE_TOOL_ID,
    (layer, options) => new PlaceLineTool(<UserLayerWithAnnotations>layer, options));
registerTool(
    ANNOTATE_ELLIPSOID_TOOL_ID,
    (layer, options) => new PlaceSphereTool(<UserLayerWithAnnotations>layer, options));
registerTool(
    ANNOTATE_COLLECTION_TOOL_ID,
    (layer, options) => new MultiStepAnnotationTool(<UserLayerWithAnnotations>layer, options));
registerTool(
    ANNOTATE_LINE_STRIP_TOOL_ID,
    (layer, options) => new PlaceLineStripTool(<UserLayerWithAnnotations>layer, options));

export interface UserLayerWithAnnotations extends UserLayer {
  annotationLayerState: WatchableRefCounted<AnnotationLayerState>;
  selectedAnnotation: SelectedAnnotationState;
  annotationColor: TrackableRGB;
  annotationFillOpacity: TrackableAlphaValue;
  initializeAnnotationLayerViewTab(tab: AnnotationLayerView): void;
  getAnnotationText(annotation: Annotation): string;
}

export function getAnnotationRenderOptions(userLayer: UserLayerWithAnnotations) {
  return {color: userLayer.annotationColor, fillOpacity: userLayer.annotationFillOpacity};
}

const SELECTED_ANNOTATION_JSON_KEY = 'selectedAnnotation';
const ANNOTATION_COLOR_JSON_KEY = 'annotationColor';
const ANNOTATION_FILL_OPACITY_JSON_KEY = 'annotationFillOpacity';
export function UserLayerWithAnnotationsMixin<TBase extends {new (...args: any[]): UserLayer}>(
    Base: TBase) {
  abstract class C extends Base implements UserLayerWithAnnotations {
    annotationLayerState = this.registerDisposer(new WatchableRefCounted<AnnotationLayerState>());
    selectedAnnotation =
        this.registerDisposer(new SelectedAnnotationState(this.annotationLayerState.addRef()));
    annotationColor = new TrackableRGB(vec3.fromValues(1, 1, 0));
    annotationFillOpacity = trackableAlphaValue(0.0);
    constructor(...args: any[]) {
      super(...args);
      this.selectedAnnotation.changed.add(this.specificationChanged.dispatch);
      this.annotationColor.changed.add(this.specificationChanged.dispatch);
      this.annotationFillOpacity.changed.add(this.specificationChanged.dispatch);
      this.tabs.add('annotations', {
        label: 'Annotations',
        order: 10,
        getter: () => new AnnotationTab(
            this, this.selectedAnnotation.addRef(), this.manager.voxelSize.addRef(),
            point => this.manager.setSpatialCoordinates(point))
      });
      this.annotationLayerState.changed.add(() => {
        const state = this.annotationLayerState.value;
        if (state !== undefined) {
          const annotationLayer = new AnnotationLayer(this.manager.chunkManager, state.addRef());
          setAnnotationHoverStateFromMouseState(state, this.manager.layerSelectedValues.mouseState);
          this.addRenderLayer(new SliceViewAnnotationLayer(annotationLayer));
          this.addRenderLayer(new PerspectiveViewAnnotationLayer(annotationLayer.addRef()));
          if (annotationLayer.source instanceof MultiscaleAnnotationSource) {
            const dataFetchLayer = this.registerDisposer(
                new DataFetchSliceViewRenderLayer(annotationLayer.source.addRef()));
            this.registerDisposer(registerNested(state.filterBySegmentation, (context, value) => {
              if (!value) {
                this.addRenderLayer(dataFetchLayer.addRef());
                context.registerDisposer(() => this.removeRenderLayer(dataFetchLayer));
              }
            }));
          }
        }
      });
    }

    restoreState(specification: any) {
      super.restoreState(specification);
      this.selectedAnnotation.restoreState(specification[SELECTED_ANNOTATION_JSON_KEY]);
      this.annotationColor.restoreState(specification[ANNOTATION_COLOR_JSON_KEY]);
      this.annotationFillOpacity.restoreState(specification[ANNOTATION_FILL_OPACITY_JSON_KEY]);
    }

    toJSON() {
      const x = super.toJSON();
      x[SELECTED_ANNOTATION_JSON_KEY] = this.selectedAnnotation.toJSON();
      x[ANNOTATION_COLOR_JSON_KEY] = this.annotationColor.toJSON();
      x[ANNOTATION_FILL_OPACITY_JSON_KEY] = this.annotationFillOpacity.toJSON();
      return x;
    }

    initializeAnnotationLayerViewTab(tab: AnnotationLayerView) {
      tab;
    }

    getAnnotationText(annotation: Annotation) {
      return annotation.description || '';
    }
  }
  return C;
}
