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

import 'neuroglancer/noselect.css';
import 'neuroglancer/segmentation_user_layer.css';

import {UserLayer} from 'neuroglancer/layer';
import {LayerListSpecification, registerLayerType, registerVolumeLayerType} from 'neuroglancer/layer_specification';
import {MeshSource, MultiscaleMeshSource} from 'neuroglancer/mesh/frontend';
import {MeshLayer, MultiscaleMeshLayer} from 'neuroglancer/mesh/frontend';
import {Overlay} from 'neuroglancer/overlay';
import {getRenderMeshByDefault} from 'neuroglancer/preferences/user_preferences';
import {RenderScaleHistogram, trackableRenderScaleTarget} from 'neuroglancer/render_scale_statistics';
import {SegmentColorHash} from 'neuroglancer/segment_color';
import {SegmentSelectionState, Uint64MapEntry} from 'neuroglancer/segmentation_display_state/frontend';
import {SharedDisjointUint64Sets} from 'neuroglancer/shared_disjoint_sets';
import {FRAGMENT_MAIN_START as SKELETON_FRAGMENT_MAIN_START, PerspectiveViewSkeletonLayer, SkeletonLayer, SkeletonRenderingOptions, SkeletonSource, SliceViewPanelSkeletonLayer, ViewSpecificSkeletonRenderingOptions} from 'neuroglancer/skeleton/frontend';
import {VolumeType} from 'neuroglancer/sliceview/volume/base';
import {SegmentationRenderLayer} from 'neuroglancer/sliceview/volume/segmentation_renderlayer';
import {StatusMessage} from 'neuroglancer/status';
import {trackableAlphaValue} from 'neuroglancer/trackable_alpha';
import {ElementVisibilityFromTrackableBoolean, TrackableBoolean, TrackableBooleanCheckbox} from 'neuroglancer/trackable_boolean';
import {ComputedWatchableValue} from 'neuroglancer/trackable_value';
import {Uint64Set} from 'neuroglancer/uint64_set';
import {UserLayerWithVolumeSourceMixin} from 'neuroglancer/user_layer_with_volume_source';
import {Borrowed} from 'neuroglancer/util/disposable';
import {parseArray, verifyObjectProperty, verifyOptionalString} from 'neuroglancer/util/json';
import {NullarySignal} from 'neuroglancer/util/signal';
import {Uint64} from 'neuroglancer/util/uint64';
import {makeWatchableShaderError} from 'neuroglancer/webgl/dynamic_shader';
import {EnumSelectWidget} from 'neuroglancer/widget/enum_widget';
import {RangeWidget} from 'neuroglancer/widget/range';
import {RenderScaleWidget} from 'neuroglancer/widget/render_scale_widget';
import {SegmentSetWidget} from 'neuroglancer/widget/segment_set_widget';
import {ShaderCodeWidget} from 'neuroglancer/widget/shader_code_widget';
import {Tab} from 'neuroglancer/widget/tab_view';
import {Uint64EntryWidget} from 'neuroglancer/widget/uint64_entry_widget';
import {OmniSegmentWidget} from 'neuroglancer/widget/omni_segment_widget';
import {SegmentMetadata, SegmentToVoxelCountMap} from 'neuroglancer/segment_metadata';

const SELECTED_ALPHA_JSON_KEY = 'selectedAlpha';
const NOT_SELECTED_ALPHA_JSON_KEY = 'notSelectedAlpha';
const OBJECT_ALPHA_JSON_KEY = 'objectAlpha';
const SATURATION_JSON_KEY = 'saturation';
const HIDE_SEGMENT_ZERO_JSON_KEY = 'hideSegmentZero';
const MESH_JSON_KEY = 'mesh';
const SKELETONS_JSON_KEY = 'skeletons';
const ROOT_SEGMENTS_JSON_KEY = 'segments';
const HIDDEN_ROOT_SEGMENTS_JSON_KEY = 'hiddenSegments';
const HIGHLIGHTS_JSON_KEY = 'highlights';
const EQUIVALENCES_JSON_KEY = 'equivalences';
const COLOR_SEED_JSON_KEY = 'colorSeed';
const MESH_RENDER_SCALE_JSON_KEY = 'meshRenderScale';

const SKELETON_RENDERING_JSON_KEY = 'skeletonRendering';
const SKELETON_SHADER_JSON_KEY = 'skeletonShader';
const SEGMENTS_TO_VOXEL_COUNT_MAP_PATH_JSON_KEY = 'segmentMetadata';
const SEGMENT_CATEGORIES_JSON_KEY = 'segmentCategories';
const CATEGORIZED_SEGMENTS_JSON_KEY = 'categorizedSegments';
const SHATTER_SEGMENT_EQUIVALENCES_JSON_KEY = 'shatterSegmentEquivalences';

const lastSegmentSelection = new Uint64();

const Base = UserLayerWithVolumeSourceMixin(UserLayer);
export class SegmentationUserLayer extends Base {
  displayState = {
    segmentColorHash: SegmentColorHash.getDefault(),
    segmentSelectionState: new SegmentSelectionState(),
    selectedAlpha: trackableAlphaValue(0.5),
    saturation: trackableAlphaValue(1.0),
    notSelectedAlpha: trackableAlphaValue(0),
    objectAlpha: trackableAlphaValue(1.0),
    hideSegmentZero: new TrackableBoolean(true, true),
    rootSegments: Uint64Set.makeWithCounterpart(this.manager.worker),
    hiddenRootSegments: new Uint64Set(),
    visibleSegments2D: new Uint64Set(),
    visibleSegments3D: Uint64Set.makeWithCounterpart(this.manager.worker),
    highlightedSegments: Uint64Set.makeWithCounterpart(this.manager.worker),
    segmentEquivalences: SharedDisjointUint64Sets.makeWithCounterpart(this.manager.worker),
    objectToDataTransform: this.transform,
    skeletonRenderingOptions: new SkeletonRenderingOptions(),
    shaderError: makeWatchableShaderError(),
    renderScaleHistogram: new RenderScaleHistogram(),
    renderScaleTarget: trackableRenderScaleTarget(1),
    shatterSegmentEquivalences: new TrackableBoolean(false, false)
  };

  /**
   * If meshPath is undefined, a default mesh source provided by the volume may be used.  If
   * meshPath is null, the default mesh source is not used.
   */
  meshPath: string|null|undefined;
  skeletonsPath: string|null|undefined;
  segmentToVoxelCountMapPath: string|undefined;
  meshLayer: Borrowed<MeshLayer|MultiscaleMeshLayer>|undefined;
  skeletonLayer: Borrowed<SkeletonLayer>|undefined;
  segmentMetadata: Borrowed<SegmentMetadata>|undefined;

  // Dispatched when either meshLayer or skeletonLayer changes.
  objectLayerStateChanged = new NullarySignal();

  constructor(public manager: LayerListSpecification, x: any) {
    super(manager, x);
    this.displayState.rootSegments.changed.add((segmentId: Uint64|null, add: boolean) => {
      this.rootSegmentChange(segmentId, add);
    });
    this.displayState.visibleSegments2D!.changed.add(this.specificationChanged.dispatch);
    this.displayState.visibleSegments3D.changed.add(this.specificationChanged.dispatch);
    this.displayState.segmentEquivalences.changed.add(this.specificationChanged.dispatch);
    this.displayState.segmentSelectionState.bindTo(manager.layerSelectedValues, this);
    this.displayState.selectedAlpha.changed.add(this.specificationChanged.dispatch);
    this.displayState.saturation.changed.add(this.specificationChanged.dispatch);
    this.displayState.notSelectedAlpha.changed.add(this.specificationChanged.dispatch);
    this.displayState.objectAlpha.changed.add(this.specificationChanged.dispatch);
    this.displayState.hideSegmentZero.changed.add(this.specificationChanged.dispatch);
    this.displayState.skeletonRenderingOptions.changed.add(this.specificationChanged.dispatch);
    this.displayState.segmentColorHash.changed.add(this.specificationChanged.dispatch);
    this.displayState.renderScaleTarget.changed.add(this.specificationChanged.dispatch);
    this.displayState.shatterSegmentEquivalences.changed.add(this.specificationChanged.dispatch);
    this.tabs.add(
        'rendering', {label: 'Rendering', order: -100, getter: () => new DisplayOptionsTab(this)});
    this.tabs.default = 'rendering';
  }

  get volumeOptions() {
    return {volumeType: VolumeType.SEGMENTATION};
  }

  restoreState(specification: any) {
    super.restoreState(specification);
    this.displayState.selectedAlpha.restoreState(specification[SELECTED_ALPHA_JSON_KEY]);
    this.displayState.saturation.restoreState(specification[SATURATION_JSON_KEY]);
    this.displayState.notSelectedAlpha.restoreState(specification[NOT_SELECTED_ALPHA_JSON_KEY]);
    this.displayState.objectAlpha.restoreState(specification[OBJECT_ALPHA_JSON_KEY]);
    this.displayState.hideSegmentZero.restoreState(specification[HIDE_SEGMENT_ZERO_JSON_KEY]);

    const {skeletonRenderingOptions} = this.displayState;
    skeletonRenderingOptions.restoreState(specification[SKELETON_RENDERING_JSON_KEY]);
    const skeletonShader = specification[SKELETON_SHADER_JSON_KEY];
    if (skeletonShader !== undefined) {
      skeletonRenderingOptions.shader.restoreState(skeletonShader);
    }
    this.displayState.segmentColorHash.restoreState(specification[COLOR_SEED_JSON_KEY]);
    this.displayState.renderScaleTarget.restoreState(specification[MESH_RENDER_SCALE_JSON_KEY]);
    this.displayState.shatterSegmentEquivalences.restoreState(specification[SHATTER_SEGMENT_EQUIVALENCES_JSON_KEY]);

    verifyObjectProperty(specification, EQUIVALENCES_JSON_KEY, y => {
      this.displayState.segmentEquivalences.restoreState(y);
    });

    const restoreSegmentsList = (key: string, segments: Uint64Set) => {
      verifyObjectProperty(specification, key, y => {
        if (y !== undefined) {
          let {segmentEquivalences} = this.displayState;
          parseArray(y, value => {
            let id = Uint64.parseString(String(value), 10);
            segments.add(segmentEquivalences.get(id));
          });
        }
      });
    };

    restoreSegmentsList(ROOT_SEGMENTS_JSON_KEY, this.displayState.rootSegments);
    restoreSegmentsList(HIDDEN_ROOT_SEGMENTS_JSON_KEY, this.displayState.hiddenRootSegments!);
    restoreSegmentsList(HIGHLIGHTS_JSON_KEY, this.displayState.highlightedSegments);

    this.displayState.highlightedSegments.changed.add(() => {
      this.specificationChanged.dispatch();
    });

    const {multiscaleSource} = this;
    let meshPath = this.meshPath = specification[MESH_JSON_KEY] === null ?
        null :
        verifyOptionalString(specification[MESH_JSON_KEY]);
    let skeletonsPath = this.skeletonsPath = specification[SKELETONS_JSON_KEY] === null ?
        null :
        verifyOptionalString(specification[SKELETONS_JSON_KEY]);
    const segmentToVoxelCountMapPath = this.segmentToVoxelCountMapPath =
        verifyOptionalString(specification[SEGMENTS_TO_VOXEL_COUNT_MAP_PATH_JSON_KEY]);
    let remaining = 0;
    if (meshPath != null && getRenderMeshByDefault()) {
      ++remaining;
      this.manager.dataSourceProvider.getMeshSource(this.manager.chunkManager, meshPath)
          .then(meshSource => {
            if (!this.wasDisposed && getRenderMeshByDefault()) {
              this.addMesh(meshSource);
              if (--remaining === 0) {
                this.isReady = true;
              }
            }
          });
    }

    if (skeletonsPath != null) {
      ++remaining;
      this.manager.dataSourceProvider.getSkeletonSource(this.manager.chunkManager, skeletonsPath)
        .then(skeletonSource => {
          if (!this.wasDisposed) {
            this.addSkeleton(skeletonSource);
            if (--remaining === 0) {
              this.isReady = true;
            }
          }
        });
    }

    if (segmentToVoxelCountMapPath) {
      ++remaining;
      this.manager.dataSourceProvider.getSegmentToVoxelCountMap(this.manager.chunkManager, segmentToVoxelCountMapPath)
        .then(segmentToVoxelCountMap => {
          if (!this.wasDisposed) {
            if (--remaining === 0) {
              this.isReady = true;
            }
          }
          if (segmentToVoxelCountMap) {
            this.restoreSegmentMetadata(
              segmentToVoxelCountMap, specification[SEGMENT_CATEGORIES_JSON_KEY],
              specification[CATEGORIZED_SEGMENTS_JSON_KEY]);
          } else {
            StatusMessage.showTemporaryMessage(
              'Segment metadata file specified in JSON state does not exist so omni segment widget won\'t be shown',
              6000);
          }
        });
    }

    if (multiscaleSource !== undefined) {
      ++remaining;
      multiscaleSource.then(volume => {
        if (!this.wasDisposed) {
          const {displayState} = this;
          this.addRenderLayer(new SegmentationRenderLayer(volume, {
            ...displayState,
            transform: displayState.objectToDataTransform,
            renderScaleHistogram: this.sliceViewRenderScaleHistogram,
            renderScaleTarget: this.sliceViewRenderScaleTarget,
          }));
          // Meshes
          if (meshPath === undefined && getRenderMeshByDefault()) {
            ++remaining;
            Promise.resolve(volume.getMeshSource()).then(meshSource => {
              if (this.wasDisposed) {
                if (meshSource !== null) {
                  meshSource.dispose();
                }
                return;
              }
              if (--remaining === 0) {
                this.isReady = true;
              }
              if ((meshSource instanceof MeshSource) ||
                  (meshSource instanceof MultiscaleMeshSource)) {
                this.addMesh(meshSource);
              }
            });
          }
          if (skeletonsPath === undefined && volume.getSkeletonSource) {
            ++remaining;
            Promise.resolve(volume.getSkeletonSource()).then(skeletonSource => {
              if (this.wasDisposed) {
                if (skeletonSource !== null) {
                  skeletonSource.dispose();
                }
                return;
              }
              if (--remaining === 0) {
                this.isReady = true;
              }
              if (skeletonSource) {
                this.addSkeleton(skeletonSource);
              }
            });
          }
          if (segmentToVoxelCountMapPath === undefined && volume.getSegmentToVoxelCountMap) {
            ++remaining;
            Promise.resolve(volume.getSegmentToVoxelCountMap()).then(segmentToVoxelCountMap => {
              if (this.wasDisposed) {
                return;
              }
              if (--remaining === 0) {
                this.isReady = true;
              }
              if (segmentToVoxelCountMap) {
                this.restoreSegmentMetadata(
                  segmentToVoxelCountMap, specification[SEGMENT_CATEGORIES_JSON_KEY],
                  specification[CATEGORIZED_SEGMENTS_JSON_KEY]);
              }
            });
          }
          if (--remaining === 0) {
            this.isReady = true;
          }
        }
      });
    }
  }

  addMesh(meshSource: MeshSource|MultiscaleMeshSource) {
    if (meshSource instanceof MeshSource) {
      this.meshLayer = new MeshLayer(this.manager.chunkManager, meshSource, this.displayState);
    } else {
      this.meshLayer =
          new MultiscaleMeshLayer(this.manager.chunkManager, meshSource, this.displayState);
    }
    this.addRenderLayer(this.meshLayer);
    this.objectLayerStateChanged.dispatch();
  }

  addSkeleton(skeletonSource: SkeletonSource) {
    let base = new SkeletonLayer(
        this.manager.chunkManager, skeletonSource, this.manager.voxelSize, this.displayState);
    this.skeletonLayer = base;
    this.addRenderLayer(new PerspectiveViewSkeletonLayer(base.addRef()));
    this.addRenderLayer(new SliceViewPanelSkeletonLayer(/* transfer ownership */ base));
    this.objectLayerStateChanged.dispatch();
  }

  toJSON() {
    const x = super.toJSON();
    x['type'] = 'segmentation';
    x[MESH_JSON_KEY] = this.meshPath;
    x[SKELETONS_JSON_KEY] = this.skeletonsPath;
    x[SELECTED_ALPHA_JSON_KEY] = this.displayState.selectedAlpha.toJSON();
    x[NOT_SELECTED_ALPHA_JSON_KEY] = this.displayState.notSelectedAlpha.toJSON();
    x[SATURATION_JSON_KEY] = this.displayState.saturation.toJSON();
    x[OBJECT_ALPHA_JSON_KEY] = this.displayState.objectAlpha.toJSON();
    x[HIDE_SEGMENT_ZERO_JSON_KEY] = this.displayState.hideSegmentZero.toJSON();
    x[COLOR_SEED_JSON_KEY] = this.displayState.segmentColorHash.toJSON();
    let {rootSegments} = this.displayState;
    if (rootSegments.size > 0) {
      x[ROOT_SEGMENTS_JSON_KEY] = rootSegments.toJSON();
    }
    const {hiddenRootSegments} = this.displayState;
    if (hiddenRootSegments!.size > 0) {
      x[HIDDEN_ROOT_SEGMENTS_JSON_KEY] = hiddenRootSegments!.toJSON();
    }
    let {highlightedSegments} = this.displayState;
    if (highlightedSegments.size > 0) {
      x[HIGHLIGHTS_JSON_KEY] = highlightedSegments.toJSON();
    }
    let {segmentEquivalences} = this.displayState;
    if (segmentEquivalences.size > 0) {
      x[EQUIVALENCES_JSON_KEY] = segmentEquivalences.toJSON();
    }
    x[SKELETON_RENDERING_JSON_KEY] = this.displayState.skeletonRenderingOptions.toJSON();
    x[MESH_RENDER_SCALE_JSON_KEY] = this.displayState.renderScaleTarget.toJSON();
    x[SEGMENTS_TO_VOXEL_COUNT_MAP_PATH_JSON_KEY] = this.segmentToVoxelCountMapPath;
    if (this.segmentMetadata) {
      const segmentCategories = this.segmentMetadata.segmentCategoriesToJSON();
      if (segmentCategories.length > 0) {
        x[SEGMENT_CATEGORIES_JSON_KEY] = segmentCategories;
        const categorizedSegments = this.segmentMetadata.categorizedSegmentsToJSON();
        if (categorizedSegments.length > 0) {
          x[CATEGORIZED_SEGMENTS_JSON_KEY] = categorizedSegments;
        }
      }
    }
    x[SHATTER_SEGMENT_EQUIVALENCES_JSON_KEY] = this.displayState.shatterSegmentEquivalences.toJSON();
    return x;
  }

  transformPickedValue(value: any) {
    if (value == null) {
      return value;
    }
    let {segmentEquivalences} = this.displayState;
    if (segmentEquivalences.size === 0) {
      return value;
    }
    if (typeof value === 'number') {
      value = new Uint64(value, 0);
    }
    let mappedValue = segmentEquivalences.get(value);
    if (Uint64.equal(mappedValue, value)) {
      return value;
    }
    return new Uint64MapEntry(value, mappedValue);
  }

  handleAction(action: string) {
    switch (action) {
      case 'recolor': {
        this.displayState.segmentColorHash.randomize();
        break;
      }
      case 'clear-segments': {
        this.displayState.rootSegments.clear();
        this.displayState.visibleSegments2D!.clear();
        this.displayState.visibleSegments3D.clear();
        this.displayState.segmentEquivalences.clear();
        break;
      }
      case 'merge-selected': {
        const firstSeg = this.displayState.rootSegments.hashTable.keys().next().value;
        for (const seg of this.displayState.rootSegments) {
          this.displayState.segmentEquivalences.link(firstSeg, seg);
        }
        break;
      }
      case 'cut-selected': {
        this.displayState.segmentEquivalences.clear();
        break;
      }
      case 'select': {
        this.selectSegment();
        break;
      }
      case 'highlight': {
        this.highlightSegment();
        break;
      }
      case 'merge-select-first': {
        this.mergeSelectFirst();
        break;
      }
      case 'merge-select-second': {
        this.mergeSelectSecond();
        break;
      }
      case 'split-select-first': {
        this.splitSelectFirst();
        break;
      }
      case 'split-select-second': {
        this.splitSelectSecond();
        break;
      }
      case 'shatter-segment-equivalences': {
        this.displayState.shatterSegmentEquivalences.value =
          !this.displayState.shatterSegmentEquivalences.value;
        break;
      }
    }
  }

  selectSegment() {
    let {segmentSelectionState} = this.displayState;
    if (segmentSelectionState.hasSelectedSegment) {
      let segment = segmentSelectionState.selectedSegment;
      let {rootSegments} = this.displayState;
      if (rootSegments.has(segment)) {
        rootSegments.delete(segment);
      } else {
        rootSegments.add(segment);
      }
    }
  }

  highlightSegment() {
    let {segmentSelectionState} = this.displayState;
    if (segmentSelectionState.hasSelectedSegment) {
      let segment = segmentSelectionState.selectedSegment;
      let {highlightedSegments} = this.displayState;
      if (highlightedSegments.has(segment)) {
        highlightedSegments.delete(segment);
      } else {
        highlightedSegments.add(segment);
      }
    }
  }

  mergeSelectFirst() {
    const {segmentSelectionState} = this.displayState;
    if (segmentSelectionState.hasSelectedSegment) {
      lastSegmentSelection.assign(segmentSelectionState.rawSelectedSegment);
      StatusMessage.showTemporaryMessage(
          `Selected ${lastSegmentSelection} as source for merge. Pick a sink.`, 3000);
    }
  }

  mergeSelectSecond() {
    const {segmentSelectionState} = this.displayState;
    if (segmentSelectionState.hasSelectedSegment) {
      const segment = segmentSelectionState.rawSelectedSegment.clone();
      this.displayState.segmentEquivalences.link(lastSegmentSelection, segment);
    }
  }

  splitSelectFirst() {
    StatusMessage.showTemporaryMessage('Cut without graph server not yet implemented.', 3000);
  }

  splitSelectSecond() {
    StatusMessage.showTemporaryMessage('Cut without graph server not yet implemented.', 3000);
  }

  rootSegmentChange(rootSegment: Uint64|null, added: boolean) {
    if (rootSegment === null && !added) {
      this.displayState.visibleSegments2D!.clear();
      this.displayState.visibleSegments3D.clear();
    } else if (added) {
      const segments = [...this.displayState.segmentEquivalences.setElements(rootSegment!)];
      this.displayState.visibleSegments3D.add(rootSegment!);
      this.displayState.visibleSegments2D!.add(rootSegment!);
      this.displayState.visibleSegments3D.add(segments);
    } else if (!added) {
      const segments = [...this.displayState.segmentEquivalences.setElements(rootSegment!)];
      this.displayState.visibleSegments2D!.delete(rootSegment!);
      this.displayState.visibleSegments3D.delete(segments);
      this.displayState.rootSegments.delete(segments);
    }
    this.specificationChanged.dispatch();
  }

  restoreSegmentMetadata(
      segmentToVoxelCountMap: SegmentToVoxelCountMap, segmentCategoriesObj: any,
      categorizedSegmentsObj: any) {
    this.segmentMetadata = SegmentMetadata.restoreState(
        segmentToVoxelCountMap, segmentCategoriesObj, categorizedSegmentsObj);
    this.segmentMetadata.changed.add(this.specificationChanged.dispatch);
    this.objectLayerStateChanged.dispatch();
  }
}

function makeSkeletonShaderCodeWidget(layer: SegmentationUserLayer) {
  return new ShaderCodeWidget({
    fragmentMain: layer.displayState.skeletonRenderingOptions.shader,
    shaderError: layer.displayState.shaderError,
    fragmentMainStartLine: SKELETON_FRAGMENT_MAIN_START,
  });
}

class DisplayOptionsTab extends Tab {
  visibleSegmentWidget = this.registerDisposer(new SegmentSetWidget(this.layer.displayState));
  addSegmentWidget = this.registerDisposer(new Uint64EntryWidget());
  selectedAlphaWidget =
      this.registerDisposer(new RangeWidget(this.layer.displayState.selectedAlpha));
  notSelectedAlphaWidget =
      this.registerDisposer(new RangeWidget(this.layer.displayState.notSelectedAlpha));
  saturationWidget = this.registerDisposer(new RangeWidget(this.layer.displayState.saturation));
  objectAlphaWidget = this.registerDisposer(new RangeWidget(this.layer.displayState.objectAlpha));
  codeWidget: ShaderCodeWidget|undefined;
  omniWidget: OmniSegmentWidget|undefined;

  constructor(public layer: SegmentationUserLayer) {
    super();
    const {element} = this;
    element.classList.add('segmentation-dropdown');
    let {selectedAlphaWidget, notSelectedAlphaWidget, saturationWidget, objectAlphaWidget} = this;
    selectedAlphaWidget.promptElement.textContent = 'Opacity (on)';
    notSelectedAlphaWidget.promptElement.textContent = 'Opacity (off)';
    saturationWidget.promptElement.textContent = 'Saturation';
    objectAlphaWidget.promptElement.textContent = 'Opacity (3d)';

    if (this.layer.volumePath !== undefined) {
      element.appendChild(this.selectedAlphaWidget.element);
      element.appendChild(this.notSelectedAlphaWidget.element);
      element.appendChild(this.saturationWidget.element);

      {
        const renderScaleWidget = this.registerDisposer(new RenderScaleWidget(
            this.layer.sliceViewRenderScaleHistogram, this.layer.sliceViewRenderScaleTarget));
        renderScaleWidget.label.textContent = 'Resolution (slice)';
        element.appendChild(renderScaleWidget.element);
      }
    }
    const has3dLayer = this.registerDisposer(new ComputedWatchableValue(
        () => this.layer.meshPath || this.layer.meshLayer || this.layer.skeletonsPath ||
                this.layer.skeletonLayer ?
            true :
            false,
        this.layer.objectLayerStateChanged));
    this.registerDisposer(
        new ElementVisibilityFromTrackableBoolean(has3dLayer, this.objectAlphaWidget.element));

    {
      const renderScaleWidget = this.registerDisposer(new RenderScaleWidget(
          this.layer.displayState.renderScaleHistogram, this.layer.displayState.renderScaleTarget));
      renderScaleWidget.label.textContent = 'Resolution (mesh)';
      element.appendChild(renderScaleWidget.element);
      this.registerDisposer(
          new ElementVisibilityFromTrackableBoolean(has3dLayer, renderScaleWidget.element));
    }
    element.appendChild(this.objectAlphaWidget.element);

    {
      const checkbox =
          this.registerDisposer(new TrackableBooleanCheckbox(layer.displayState.hideSegmentZero));
      checkbox.element.className =
          'neuroglancer-segmentation-dropdown-hide-segment-zero neuroglancer-noselect';
      const label = document.createElement('label');
      label.className =
          'neuroglancer-segmentation-dropdown-hide-segment-zero neuroglancer-noselect';
      label.appendChild(document.createTextNode('Hide segment ID 0'));
      label.appendChild(checkbox.element);
      element.appendChild(label);
    }

    this.addSegmentWidget.element.classList.add('add-segment');
    this.addSegmentWidget.element.title = 'Add one or more segment IDs';
    element.appendChild(this.registerDisposer(this.addSegmentWidget).element);
    this.registerDisposer(this.addSegmentWidget.valuesEntered.add((values: Uint64[]) => {
      for (const value of values) {
        this.layer.displayState.rootSegments.add(value);
      }
    }));
    element.appendChild(this.registerDisposer(this.visibleSegmentWidget).element);

    const maybeAddOmniSegmentWidget = () => {
      if (this.omniWidget || (!layer.segmentMetadata)) {
        return;
      }
      {
        this.omniWidget = this.registerDisposer(new OmniSegmentWidget(
            layer.displayState, layer.segmentMetadata));
        element.appendChild(this.omniWidget.element);
      }
    };

    const maybeAddSkeletonShaderUI = () => {
      if (this.codeWidget !== undefined) {
        return;
      }
      if (this.layer.skeletonsPath === null || this.layer.skeletonLayer === undefined) {
        return;
      }
      const addViewSpecificSkeletonRenderingControls =
          (options: ViewSpecificSkeletonRenderingOptions, viewName: string) => {
            {
              const widget = this.registerDisposer(new EnumSelectWidget(options.mode));
              const label = document.createElement('label');
              label.className =
                  'neuroglancer-segmentation-dropdown-skeleton-render-mode neuroglancer-noselect';
              label.appendChild(document.createTextNode(`Skeleton mode (${viewName})`));
              label.appendChild(widget.element);
              element.appendChild(label);
            }
            {
              const widget = this.registerDisposer(
                  new RangeWidget(options.lineWidth, {min: 1, max: 40, step: 1}));
              widget.promptElement.textContent = `Skeleton line width (${viewName})`;
              element.appendChild(widget.element);
            }
          };
      addViewSpecificSkeletonRenderingControls(
          layer.displayState.skeletonRenderingOptions.params2d, '2d');
      addViewSpecificSkeletonRenderingControls(
          layer.displayState.skeletonRenderingOptions.params3d, '3d');
      let topRow = document.createElement('div');
      topRow.className = 'neuroglancer-segmentation-dropdown-skeleton-shader-header';
      let label = document.createElement('div');
      label.style.flex = '1';
      label.textContent = 'Skeleton shader:';
      let helpLink = document.createElement('a');
      let helpButton = document.createElement('button');
      helpButton.type = 'button';
      helpButton.textContent = '?';
      helpButton.className = 'help-link';
      helpLink.appendChild(helpButton);
      helpLink.title = 'Documentation on skeleton rendering';
      helpLink.target = '_blank';
      helpLink.href =
          'https://github.com/google/neuroglancer/blob/master/src/neuroglancer/sliceview/image_layer_rendering.md';

      let maximizeButton = document.createElement('button');
      maximizeButton.innerHTML = '&square;';
      maximizeButton.className = 'maximize-button';
      maximizeButton.title = 'Show larger editor view';
      this.registerEventListener(maximizeButton, 'click', () => {
        new ShaderCodeOverlay(this.layer);
      });

      topRow.appendChild(label);
      topRow.appendChild(maximizeButton);
      topRow.appendChild(helpLink);

      element.appendChild(topRow);

      const codeWidget = this.codeWidget =
          this.registerDisposer(makeSkeletonShaderCodeWidget(this.layer));
      element.appendChild(codeWidget.element);
      codeWidget.textEditor.refresh();
    };
    this.registerDisposer(this.layer.objectLayerStateChanged.add(maybeAddSkeletonShaderUI));
    this.registerDisposer(this.layer.objectLayerStateChanged.add(maybeAddOmniSegmentWidget));
    maybeAddSkeletonShaderUI();

    this.visibility.changed.add(() => {
      if (this.visible) {
        if (this.codeWidget !== undefined) {
          this.codeWidget.textEditor.refresh();
        }
      }
    });
  }
}

class ShaderCodeOverlay extends Overlay {
  codeWidget = this.registerDisposer(makeSkeletonShaderCodeWidget(this.layer));
  constructor(public layer: SegmentationUserLayer) {
    super();
    this.content.classList.add('neuroglancer-segmentation-layer-skeleton-shader-overlay');
    this.content.appendChild(this.codeWidget.element);
    this.codeWidget.textEditor.refresh();
  }
}

registerLayerType('segmentation', SegmentationUserLayer);
registerVolumeLayerType(VolumeType.SEGMENTATION, SegmentationUserLayer);
