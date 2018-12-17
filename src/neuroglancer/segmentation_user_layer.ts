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

import {SegmentSelection, ChunkedGraphLayer} from 'neuroglancer/sliceview/chunked_graph/frontend';
import {UserLayer} from 'neuroglancer/layer';
import {LayerListSpecification, registerLayerType, registerVolumeLayerType} from 'neuroglancer/layer_specification';
import {MeshSource} from 'neuroglancer/mesh/frontend';
import {MeshLayer} from 'neuroglancer/mesh/frontend';
import {Overlay} from 'neuroglancer/overlay';
import {SegmentColorHash} from 'neuroglancer/segment_color';
import {Bounds} from 'neuroglancer/segmentation_display_state/base';
import {SegmentationDisplayState3D, SegmentSelectionState, Uint64MapEntry} from 'neuroglancer/segmentation_display_state/frontend';
import {SharedDisjointUint64Sets} from 'neuroglancer/shared_disjoint_sets';
import {SharedWatchableValue} from 'neuroglancer/shared_watchable_value';
import {FRAGMENT_MAIN_START as SKELETON_FRAGMENT_MAIN_START, getTrackableFragmentMain, PerspectiveViewSkeletonLayer, SkeletonLayer, SkeletonLayerDisplayState, SkeletonSource, SliceViewPanelSkeletonLayer} from 'neuroglancer/skeleton/frontend';
import {VolumeType} from 'neuroglancer/sliceview/volume/base';
import {SegmentationRenderLayer, SliceViewSegmentationDisplayState} from 'neuroglancer/sliceview/volume/segmentation_renderlayer';
import {StatusMessage} from 'neuroglancer/status';
import {trackableAlphaValue} from 'neuroglancer/trackable_alpha';
import {ElementVisibilityFromTrackableBoolean, TrackableBoolean, TrackableBooleanCheckbox} from 'neuroglancer/trackable_boolean';
import {ComputedWatchableValue} from 'neuroglancer/trackable_value';
import {Uint64Set} from 'neuroglancer/uint64_set';
import {UserLayerWithMIPLevelConstraintsMixin} from 'neuroglancer/user_layer_with_mip_level_constraints';
import {Borrowed} from 'neuroglancer/util/disposable';
import {vec3} from 'neuroglancer/util/geom';
import {parseArray, verify3dVec, verifyObjectProperty, verifyOptionalString} from 'neuroglancer/util/json';
import {NullarySignal} from 'neuroglancer/util/signal';
import {Uint64} from 'neuroglancer/util/uint64';
import {makeWatchableShaderError} from 'neuroglancer/webgl/dynamic_shader';
import {ChunkedGraphWidget} from 'neuroglancer/widget/chunked_graph_widget';
import {RangeWidget} from 'neuroglancer/widget/range';
import {SegmentSetWidget} from 'neuroglancer/widget/segment_set_widget';
import {ShaderCodeWidget} from 'neuroglancer/widget/shader_code_widget';
import {Tab} from 'neuroglancer/widget/tab_view';
import {Uint64EntryWidget} from 'neuroglancer/widget/uint64_entry_widget';

require('neuroglancer/noselect.css');
require('./segmentation_user_layer.css');

const SELECTED_ALPHA_JSON_KEY = 'selectedAlpha';
const NOT_SELECTED_ALPHA_JSON_KEY = 'notSelectedAlpha';
const OBJECT_ALPHA_JSON_KEY = 'objectAlpha';
const SATURATION_JSON_KEY = 'saturation';
const HIDE_SEGMENT_ZERO_JSON_KEY = 'hideSegmentZero';
const CHUNKED_GRAPH_JSON_KEY = 'chunkedGraph';
const MESH_JSON_KEY = 'mesh';
const SKELETONS_JSON_KEY = 'skeletons';
const ROOT_SEGMENTS_JSON_KEY = 'segments';
const HIDDEN_ROOT_SEGMENTS_JSON_KEY = 'hiddenSegments';
const HIGHLIGHTS_JSON_KEY = 'highlights';
const EQUIVALENCES_JSON_KEY = 'equivalences';
const CLIP_BOUNDS_JSON_KEY = 'clipBounds';
const SKELETON_SHADER_JSON_KEY = 'skeletonShader';

const Base = UserLayerWithMIPLevelConstraintsMixin(UserLayer);
export class SegmentationUserLayer extends Base {
  displayState: SliceViewSegmentationDisplayState&SegmentationDisplayState3D&
      SkeletonLayerDisplayState = {
        segmentColorHash: SegmentColorHash.getDefault(),
        segmentSelectionState: new SegmentSelectionState(),
        selectedAlpha: trackableAlphaValue(0.5),
        saturation: trackableAlphaValue(1.0),
        notSelectedAlpha: trackableAlphaValue(0),
        objectAlpha: trackableAlphaValue(1.0),
        clipBounds: SharedWatchableValue.make<Bounds|undefined>(this.manager.worker, undefined),
        hideSegmentZero: new TrackableBoolean(true, true),
        rootSegments: Uint64Set.makeWithCounterpart(this.manager.worker),
        hiddenRootSegments: new Uint64Set(),
        visibleSegments2D: new Uint64Set(),
        visibleSegments3D: Uint64Set.makeWithCounterpart(this.manager.worker),
        highlightedSegments: Uint64Set.makeWithCounterpart(this.manager.worker),
        segmentEquivalences: SharedDisjointUint64Sets.makeWithCounterpart(this.manager.worker),
        objectToDataTransform: this.transform,
        fragmentMain: getTrackableFragmentMain(),
        shaderError: makeWatchableShaderError(),
        mipLevelConstraints: this.mipLevelConstraints
      };

  /**
   * If meshPath is undefined, a default mesh source provided by the volume may be used.  If
   * meshPath is null, the default mesh source is not used.
   */
  chunkedGraphUrl: string|null|undefined;
  meshPath: string|null|undefined;
  skeletonsPath: string|null|undefined;
  chunkedGraphLayer: Borrowed<ChunkedGraphLayer>|undefined;
  meshLayer: Borrowed<MeshLayer>|undefined;
  skeletonLayer: Borrowed<SkeletonLayer>|undefined;

  // Dispatched when either meshLayer or skeletonLayer changes.
  objectLayerStateChanged = new NullarySignal();

  private pendingGraphMod: {
    source: SegmentSelection[],
    sink: SegmentSelection[],
  };

  constructor(public manager: LayerListSpecification, x: any) {
    super(manager, x);
    this.displayState.rootSegments.changed.add((segmentId: Uint64|null, add: boolean) => {
      this.rootSegmentChange(segmentId, add);
    });
    this.displayState.visibleSegments2D!.changed.add(() => {
      this.specificationChanged.dispatch();
    });
    this.displayState.visibleSegments3D.changed.add(() => {
      this.specificationChanged.dispatch();
    });
    this.displayState.segmentEquivalences.changed.add(() => {
      this.specificationChanged.dispatch();
    });
    this.displayState.segmentSelectionState.bindTo(manager.layerSelectedValues, this);
    this.displayState.selectedAlpha.changed.add(() => this.specificationChanged.dispatch());
    this.displayState.notSelectedAlpha.changed.add(() => this.specificationChanged.dispatch());
    this.displayState.objectAlpha.changed.add(() => this.specificationChanged.dispatch());
    this.displayState.hideSegmentZero.changed.add(() => this.specificationChanged.dispatch());
    this.displayState.fragmentMain.changed.add(() => this.specificationChanged.dispatch());
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
    this.displayState.fragmentMain.restoreState(specification[SKELETON_SHADER_JSON_KEY]);

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

    verifyObjectProperty(specification, CLIP_BOUNDS_JSON_KEY, y => {
      if (y === undefined) {
        return;
      }
      let center: vec3|undefined, size: vec3|undefined;
      verifyObjectProperty(y, 'center', z => center = verify3dVec(z));
      verifyObjectProperty(y, 'size', z => size = verify3dVec(z));
      if (!center || !size) {
        return;
      }
      let bounds = {center, size};
      this.displayState.clipBounds.value = bounds;
    });
    this.displayState.highlightedSegments.changed.add(() => {
      this.specificationChanged.dispatch();
    });

    const {multiscaleSource} = this;
    this.chunkedGraphUrl = specification[CHUNKED_GRAPH_JSON_KEY] === null ?
        null :
        verifyOptionalString(specification[CHUNKED_GRAPH_JSON_KEY]);
    let meshPath = this.meshPath = specification[MESH_JSON_KEY] === null ?
        null :
        verifyOptionalString(specification[MESH_JSON_KEY]);
    let skeletonsPath = this.skeletonsPath = specification[SKELETONS_JSON_KEY] === null ?
        null :
        verifyOptionalString(specification[SKELETONS_JSON_KEY]);
    let remaining = 0;
    if (meshPath != null) {
      ++remaining;
      this.manager.dataSourceProvider.getMeshSource(this.manager.chunkManager, meshPath)
          .then(meshSource => {
            if (!this.wasDisposed) {
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

    if (multiscaleSource !== undefined) {
      ++remaining;
      multiscaleSource.then(volume => {
        if (!this.wasDisposed) {
          const segmentationRenderLayer = new SegmentationRenderLayer(volume, this.displayState);
          this.populateVoxelSelectionWidget(segmentationRenderLayer);
          this.addRenderLayer(segmentationRenderLayer);
          // Chunked Graph Server
          if (this.chunkedGraphUrl === undefined && volume.getChunkedGraphUrl) {
            this.chunkedGraphUrl = volume.getChunkedGraphUrl();
          }
          // Chunked Graph Supervoxels
          if (this.chunkedGraphUrl && volume.getChunkedGraphSources) {
            let chunkedGraphSources = volume.getChunkedGraphSources(
              {rootUri: this.chunkedGraphUrl}, this.displayState.rootSegments);

            if (chunkedGraphSources) {
              this.chunkedGraphLayer = new ChunkedGraphLayer(this.manager.chunkManager, this.chunkedGraphUrl, chunkedGraphSources, this.displayState);
              this.addRenderLayer(this.chunkedGraphLayer);

              // Have to wait for graph server initialization to fetch agglomerations
              this.displayState.segmentEquivalences.clear();
              verifyObjectProperty(specification, ROOT_SEGMENTS_JSON_KEY, y => {
                if (y !== undefined) {
                  let {rootSegments} = this.displayState;
                  parseArray(y, value => {
                    rootSegments.add(Uint64.parseString(String(value), 10));
                  });
                }
              });
            }
          }
          // Meshes
          if (meshPath === undefined) {
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
              if (meshSource) {
                this.addMesh(meshSource, this.chunkedGraphLayer);
                this.objectLayerStateChanged.dispatch();
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
                this.addSkeleton(skeletonSource, this.chunkedGraphLayer);
                this.objectLayerStateChanged.dispatch();
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

  addMesh(meshSource: MeshSource, chunkedGraph?: ChunkedGraphLayer) {
    this.meshLayer = new MeshLayer(this.manager.chunkManager, chunkedGraph ? chunkedGraph : null, meshSource, this.displayState);
    this.addRenderLayer(this.meshLayer);
  }

  addSkeleton(skeletonSource: SkeletonSource, chunkedGraph?: ChunkedGraphLayer) {
    let base = new SkeletonLayer(
        this.manager.chunkManager, chunkedGraph ? chunkedGraph : null, skeletonSource, this.manager.voxelSize, this.displayState);
    this.skeletonLayer = base;
    this.addRenderLayer(new PerspectiveViewSkeletonLayer(base.addRef()));
    this.addRenderLayer(new SliceViewPanelSkeletonLayer(/* transfer ownership */ base));
  }

  toJSON() {
    const x = super.toJSON();
    x['type'] = 'segmentation';
    x[MESH_JSON_KEY] = this.meshPath;
    x[SKELETONS_JSON_KEY] = this.skeletonsPath;
    x[CHUNKED_GRAPH_JSON_KEY] = this.chunkedGraphUrl;
    x[SELECTED_ALPHA_JSON_KEY] = this.displayState.selectedAlpha.toJSON();
    x[NOT_SELECTED_ALPHA_JSON_KEY] = this.displayState.notSelectedAlpha.toJSON();
    x[SATURATION_JSON_KEY] = this.displayState.saturation.toJSON();
    x[OBJECT_ALPHA_JSON_KEY] = this.displayState.objectAlpha.toJSON();
    x[HIDE_SEGMENT_ZERO_JSON_KEY] = this.displayState.hideSegmentZero.toJSON();
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
    if (segmentEquivalences.size > 0 && !this.chunkedGraphUrl) { // Too many equivalences when using Chunked Graph
      x[EQUIVALENCES_JSON_KEY] = segmentEquivalences.toJSON();
    }
    let {clipBounds} = this.displayState;
    if (clipBounds.value) {
      x[CLIP_BOUNDS_JSON_KEY] = {
        center: Array.from(clipBounds.value.center),
        size: Array.from(clipBounds.value.size),
      };
    }
    x[SKELETON_SHADER_JSON_KEY] = this.displayState.fragmentMain.toJSON();
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
        if (this.chunkedGraphLayer) {
          StatusMessage.showTemporaryMessage(`Graph-enabled segmentation layers only support 2-point-merge.`, 3000);
        } else {
          const firstSeg = this.displayState.rootSegments.hashTable.keys().next().value;
          for (const seg of this.displayState.rootSegments) {
            this.displayState.segmentEquivalences.link(firstSeg, seg);
          }
        }
        break;
      }
      case 'cut-selected': {
        if (this.chunkedGraphLayer) {
          StatusMessage.showTemporaryMessage(`Graph-enabled segmentation layers only support 2-point-split.`, 3000);
        } else {
          this.displayState.segmentEquivalences.clear();
        }
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
    }
  }

  selectSegment() {
    let {segmentSelectionState} = this.displayState;
    if (segmentSelectionState.hasSelectedSegment) {
      let segment = segmentSelectionState.selectedSegment;
      let {rootSegments} = this.displayState;
      if (rootSegments.has(segment)) {
        rootSegments.delete(segment);
      } else if (this.chunkedGraphLayer) {
        let coordinates = [...this.manager.layerSelectedValues.mouseState.position.values()].map((v, i) => {
          return Math.round(v / this.manager.voxelSize.size[i]);
        });

        let selection = {segmentId: segment.clone(), rootId: segment.clone(), position: coordinates};

        this.chunkedGraphLayer.getRoot(selection).then(rootSegment => {
          rootSegments.add(rootSegment);
        }).catch((e: Error) => {
          console.log(e);
          StatusMessage.showTemporaryMessage(e.message, 3000);
        });
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
    let {segmentSelectionState} = this.displayState;
    if (segmentSelectionState.hasSelectedSegment) {
      let segment = segmentSelectionState.rawSelectedSegment;
      let root = segmentSelectionState.selectedSegment;
      let coordinates = [...this.manager.layerSelectedValues.mouseState.position.values()].map((v, i) => {
        return Math.round(v / this.manager.voxelSize.size[i]);
      });

      this.pendingGraphMod = {
        source: [{segmentId: segment.clone(), rootId: root.clone(), position: coordinates}],
        sink: [{segmentId: new Uint64(0), rootId: new Uint64(0), position: coordinates}]
      };
      StatusMessage.showTemporaryMessage(`Selected ${segment} as source for merge. Pick a sink.`, 3000);
    }
  }

  mergeSelectSecond() {
    let {segmentSelectionState, rootSegments} = this.displayState;
    if (segmentSelectionState.hasSelectedSegment) {
      let segment = segmentSelectionState.rawSelectedSegment;
      let root = segmentSelectionState.selectedSegment;
      let coordinates = [...this.manager.layerSelectedValues.mouseState.position.values()].map((v, i) => {
        return Math.round(v / this.manager.voxelSize.size[i]);
      });

      this.pendingGraphMod.sink[0] = {segmentId: segment.clone(), rootId: root.clone(), position: coordinates};
      StatusMessage.showTemporaryMessage(`Selected ${segment} as sink for merge.`, 3000);

      if (this.chunkedGraphLayer) {
        this.chunkedGraphLayer.mergeSegments(this.pendingGraphMod.source[0], this.pendingGraphMod.sink[0]).then((mergedRoot) => {
          rootSegments.delete(this.pendingGraphMod.sink[0].rootId);
          rootSegments.delete(this.pendingGraphMod.source[0].rootId);
          rootSegments.add(mergedRoot);
        });
      }
      else {
        this.displayState.segmentEquivalences.link(this.pendingGraphMod.source[0].segmentId, this.pendingGraphMod.sink[0].segmentId);
      }
    }
  }

  splitSelectFirst() {
    let {segmentSelectionState} = this.displayState;
    if (segmentSelectionState.hasSelectedSegment) {
      let segment = segmentSelectionState.rawSelectedSegment;
      let root = segmentSelectionState.selectedSegment;
      let coordinates = [...this.manager.layerSelectedValues.mouseState.position.values()].map((v, i) => {
        return Math.round(v / this.manager.voxelSize.size[i]);
      });

      this.pendingGraphMod = {
        source: [{segmentId: segment.clone(), rootId: root.clone(), position: coordinates}],
        sink: [{segmentId: new Uint64(0), rootId: new Uint64(0), position: coordinates}]
      };
      StatusMessage.showTemporaryMessage(`Selected ${segment} as source for split. Pick a sink.`, 3000);
    }
  }

  splitSelectSecond() {
    let {segmentSelectionState, rootSegments} = this.displayState;
    if (segmentSelectionState.hasSelectedSegment) {
      let segment = segmentSelectionState.rawSelectedSegment;
      let root = segmentSelectionState.selectedSegment;
      let coordinates = [...this.manager.layerSelectedValues.mouseState.position.values()].map((v, i) => {
        return Math.round(v / this.manager.voxelSize.size[i]);
      });

      this.pendingGraphMod.sink[0] = {segmentId: segment.clone(), rootId: root.clone(), position: coordinates};
      StatusMessage.showTemporaryMessage(`Selected ${segment} as sink for split.`, 3000);

      if (this.chunkedGraphLayer) {
        this.chunkedGraphLayer.splitSegments(this.pendingGraphMod.source, this.pendingGraphMod.sink).then((splitRoots) => {
          if (splitRoots.length === 0) {
            StatusMessage.showTemporaryMessage(`No split found.`, 3000);
            return;
          }
          for (let sink of this.pendingGraphMod.sink) {
            rootSegments.delete(sink.rootId);
          }
          for (let splitRoot of splitRoots) {
            rootSegments.add(splitRoot);
          }
        });
      }
      else {
        StatusMessage.showTemporaryMessage('Cut without graph server not yet implemented.', 3000);
      }
    }
  }

  rootSegmentChange(rootSegment: Uint64 | null, added: boolean) {
    if (rootSegment === null && !added) {
      // Clear all segment sets
      let leafSegmentCount = this.displayState.visibleSegments2D!.size;
      this.displayState.visibleSegments2D!.clear();
      this.displayState.visibleSegments3D.clear();
      this.displayState.segmentEquivalences.clear();
      StatusMessage.showTemporaryMessage(`Deselected all ${leafSegmentCount} segments.`, 3000);
    } else if (added) {
      this.displayState.visibleSegments3D.add(rootSegment!);
      this.displayState.visibleSegments2D!.add(rootSegment!);
    } else if (!added) {
      let segments = [...this.displayState.segmentEquivalences.setElements(rootSegment!)];
      let segmentCount = segments.length; // Wrong count, but faster than below

      this.displayState.visibleSegments2D!.delete(rootSegment!);

      for (let e of segments) {
        this.displayState.visibleSegments3D.delete(e);
      }
      if (!this.chunkedGraphUrl) {
        // Without graph server, equivalent segments are also stored in `rootSegments`
        for (let e of segments) {
          this.displayState.rootSegments.delete(e);
        }
      }

      this.displayState.segmentEquivalences.deleteSet(rootSegment!);
      StatusMessage.showTemporaryMessage(`Deselected ${segmentCount} segments.`);
    }
    this.specificationChanged.dispatch();
  }
}

function makeSkeletonShaderCodeWidget(layer: SegmentationUserLayer) {
  return new ShaderCodeWidget({
    fragmentMain: layer.displayState.fragmentMain,
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
  chunkedGraphWidget: ChunkedGraphWidget|undefined;

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
    }
    this.registerDisposer(new ElementVisibilityFromTrackableBoolean(
        this.registerDisposer(new ComputedWatchableValue(
            () => this.layer.meshPath || this.layer.meshLayer || this.layer.skeletonsPath ||
                    this.layer.skeletonLayer ?
                true :
                false,
            this.layer.objectLayerStateChanged)),
        this.objectAlphaWidget.element));
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

    if (layer.chunkedGraphUrl && this.chunkedGraphWidget == null) {
      const chunkedGraphWidget =
          this.registerDisposer(new ChunkedGraphWidget({url: layer.chunkedGraphUrl || ''}));
      element.appendChild(chunkedGraphWidget.element);
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

    const maybeAddSkeletonShaderUI = () => {
      if (this.codeWidget !== undefined) {
        return;
      }
      if (this.layer.skeletonsPath === null || this.layer.skeletonLayer === undefined) {
        return;
      }
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
