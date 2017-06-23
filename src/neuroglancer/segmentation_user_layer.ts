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

import {CoordinateTransform} from 'neuroglancer/coordinate_transform';
import {getMeshSource, getSkeletonSource} from 'neuroglancer/datasource/factory';
import {UserLayer, UserLayerDropdown} from 'neuroglancer/layer';
import {LayerListSpecification, registerLayerType, registerVolumeLayerType} from 'neuroglancer/layer_specification';
import {getVolumeWithStatusMessage} from 'neuroglancer/layer_specification';
import {MeshSource} from 'neuroglancer/mesh/frontend';
import {MeshLayer} from 'neuroglancer/mesh/frontend';
import {SegmentColorHash} from 'neuroglancer/segment_color';
import {SegmentationDisplayState3D, SegmentSelectionState, Uint64MapEntry} from 'neuroglancer/segmentation_display_state/frontend';
import {SharedDisjointUint64Sets} from 'neuroglancer/shared_disjoint_sets';
import {PerspectiveViewSkeletonLayer, SkeletonLayer, SliceViewPanelSkeletonLayer} from 'neuroglancer/skeleton/frontend';
import {VolumeType} from 'neuroglancer/sliceview/base';
import {SegmentationRenderLayer, SliceViewSegmentationDisplayState} from 'neuroglancer/sliceview/segmentation_renderlayer';
import {trackableAlphaValue} from 'neuroglancer/trackable_alpha';
import {Uint64Set} from 'neuroglancer/uint64_set';
import {parseArray, verifyObjectProperty, verifyOptionalString} from 'neuroglancer/util/json';
import {Uint64} from 'neuroglancer/util/uint64';
import {RangeWidget} from 'neuroglancer/widget/range';
import {SegmentSetWidget} from 'neuroglancer/widget/segment_set_widget';
import {Uint64EntryWidget} from 'neuroglancer/widget/uint64_entry_widget';
import {SemanticEntryWidget} from 'neuroglancer/widget/semantic_entry_widget';
import {openHttpRequest, sendHttpRequest} from 'neuroglancer/util/http_request';
import {splitObject, mergeNodes, getObjectList, getRoot, getLeaves, getChildren, enableGraphServer, GRAPH_SERVER_NOT_ENABLED} from 'neuroglancer/object_graph_service';
import {StatusMessage} from 'neuroglancer/status';
import {HashMapUint64} from 'neuroglancer/gpu_hash/hash_table';

require('./segmentation_user_layer.css');

const SELECTED_ALPHA_JSON_KEY = 'selectedAlpha';
const NOT_SELECTED_ALPHA_JSON_KEY = 'notSelectedAlpha';
const OBJECT_ALPHA_JSON_KEY = 'objectAlpha';

interface SourceSink {
  sources: Uint64[],
  sinks: Uint64[],
}

function handleDisabledGraphServer (error: any) {
    if (error === GRAPH_SERVER_NOT_ENABLED) {
      return;
    }

    throw new Error(error);
}

export class SegmentationUserLayer extends UserLayer {
  displayState: SliceViewSegmentationDisplayState&SegmentationDisplayState3D = {
    segmentColorHash: SegmentColorHash.getDefault(),
    segmentSelectionState: new SegmentSelectionState(),
    selectedAlpha: trackableAlphaValue(0.5),
    notSelectedAlpha: trackableAlphaValue(0),
    objectAlpha: trackableAlphaValue(1.0),
    rootSegments: Uint64Set.makeWithCounterpart(this.manager.worker),
    visibleSegments2D: Uint64Set.makeWithCounterpart(this.manager.worker),
    visibleSegments3D: Uint64Set.makeWithCounterpart(this.manager.worker),
    segmentEquivalences: SharedDisjointUint64Sets.makeWithCounterpart(this.manager.worker),
    volumeSourceOptions: {},
    objectToDataTransform: new CoordinateTransform(),
    shattered: false,
    semanticHashMap: new HashMapUint64(),
    semanticMode: false
  };
  volumePath: string|undefined;
  meshPath: string|undefined;
  skeletonsPath: string|undefined;
  graphPath: string|undefined;
  meshLayer: MeshLayer|undefined;
  splitPartitions: SourceSink = {
    sources: [],
    sinks: [],
  };

  constructor(public manager: LayerListSpecification, spec: any) {
    super([]);
    this.displayState.rootSegments.changed.add((rootSegment: Uint64, added: boolean) => {
      if (rootSegment === null && !added) {
        // Clear all segment sets
        let leafSegmentCount = this.displayState.visibleSegments2D.size;
        this.displayState.visibleSegments2D.clear();
        this.displayState.visibleSegments3D.clear();
        StatusMessage.displayText(`Deselected all ${leafSegmentCount} segments.`);
      } else if (added) {
        // Add root to 3D set, and leaves to 2D set
        this.displayState.visibleSegments3D.add(rootSegment);
        getLeaves(rootSegment).then(leafSegments => {
          for (let seg of leafSegments) {
            this.displayState.visibleSegments2D.add(seg);
          }
          StatusMessage.displayText(`Selected ${leafSegments.length} segments.`);
        }).catch(e => handleDisabledGraphServer(e));
      } else if (!added) {
        // Remove leaves from 2D set; and root plus possible descendants from 3D set
        const that = this;
        function remove3DChildren(seg: Uint64) {
          if (that.displayState.visibleSegments3D.has(seg)) {
            that.displayState.visibleSegments3D.delete(seg);
          } else {
            getChildren(seg).then(childIds => {
              for (let seg of childIds) {
                console.log(`Calling recursively for ${seg}`)
                remove3DChildren(seg);
              }
            }).catch(e => handleDisabledGraphServer(e));
          }
        }
        remove3DChildren(rootSegment);
        getLeaves(rootSegment).then(leafSegments => {
          for (let seg of leafSegments) {
            this.displayState.visibleSegments2D.delete(seg);
          }
          StatusMessage.displayText(`Deselected ${leafSegments.length} segments.`);
        }).catch(e => handleDisabledGraphServer(e));
      }
      this.specificationChanged.dispatch();
    });
    this.displayState.visibleSegments2D.changed.add(() => { this.specificationChanged.dispatch(); });
    this.displayState.visibleSegments3D.changed.add(() => { this.specificationChanged.dispatch(); });
    this.displayState.segmentEquivalences.changed.add(
        () => { this.specificationChanged.dispatch(); });
    this.displayState.segmentSelectionState.bindTo(manager.layerSelectedValues, this);
    this.displayState.selectedAlpha.changed.add(() => { this.specificationChanged.dispatch(); });
    this.displayState.notSelectedAlpha.changed.add(() => { this.specificationChanged.dispatch(); });
    this.displayState.objectAlpha.changed.add(() => { this.specificationChanged.dispatch(); });

    this.displayState.selectedAlpha.restoreState(spec[SELECTED_ALPHA_JSON_KEY]);
    this.displayState.notSelectedAlpha.restoreState(spec[NOT_SELECTED_ALPHA_JSON_KEY]);
    this.displayState.objectAlpha.restoreState(spec[OBJECT_ALPHA_JSON_KEY]);
    this.displayState.objectToDataTransform.restoreState(spec['transform']);
    this.displayState.volumeSourceOptions.transform =
        this.displayState.objectToDataTransform.transform;

    let volumePath = this.volumePath = verifyOptionalString(spec['source']);
    let meshPath = this.meshPath = verifyOptionalString(spec['mesh']);
    let skeletonsPath = this.skeletonsPath = verifyOptionalString(spec['skeletons']);
    let graphPath = this.graphPath = verifyOptionalString(spec['graph']);

    if (volumePath !== undefined) {
      getVolumeWithStatusMessage(manager.chunkManager, volumePath, {
        volumeType: VolumeType.SEGMENTATION
      }).then(volume => {
        if (!this.wasDisposed) {
          this.addRenderLayer(new SegmentationRenderLayer(volume, this.displayState));
          if (meshPath === undefined) {
            let meshSource = volume.getMeshSource();
            if (meshSource != null) {
              this.addMesh(meshSource);
            }
          }
        }
      });
    }

    if (meshPath !== undefined) {
      getMeshSource(manager.chunkManager, meshPath).then(meshSource => {
        if (!this.wasDisposed) {
          this.addMesh(meshSource);
        }
      });
    }

    if (skeletonsPath !== undefined) {
      getSkeletonSource(manager.chunkManager, skeletonsPath).then(skeletonSource => {
        if (!this.wasDisposed) {
          let base = new SkeletonLayer(
              manager.chunkManager, skeletonSource, manager.voxelSize, this.displayState);
          this.addRenderLayer(new PerspectiveViewSkeletonLayer(base));
          this.addRenderLayer(new SliceViewPanelSkeletonLayer(base));
        }
      });
    }


    verifyObjectProperty(
        spec, 'equivalences', y => { this.displayState.segmentEquivalences.restoreState(y); });

    if (graphPath !== undefined) {
      enableGraphServer(graphPath);

      getObjectList().then(equivalences => {
        this.displayState.segmentEquivalences.addSets(equivalences);
      });
    }

    verifyObjectProperty(spec, 'segments', y => {
      if (y !== undefined) {
        let {rootSegments, segmentEquivalences} = this.displayState;
        parseArray(y, value => {
          let id = Uint64.parseString(String(value), 10);
          rootSegments.add(segmentEquivalences.get(id));
          rootSegments.add(id);
        });
      }
    });
  }

  addMesh(meshSource: MeshSource) {
    this.meshLayer = new MeshLayer(this.manager.chunkManager, meshSource, this.graphPath, this.displayState);
    this.addRenderLayer(this.meshLayer);
  }

  toJSON() {
    let x: any = {'type': 'segmentation'};
    x['source'] = this.volumePath;
    x['mesh'] = this.meshPath;
    x['skeletons'] = this.skeletonsPath;
    x['graph'] = this.graphPath;
    x[SELECTED_ALPHA_JSON_KEY] = this.displayState.selectedAlpha.toJSON();
    x[NOT_SELECTED_ALPHA_JSON_KEY] = this.displayState.notSelectedAlpha.toJSON();
    x[OBJECT_ALPHA_JSON_KEY] = this.displayState.objectAlpha.toJSON();
    let {rootSegments} = this.displayState;
    if (rootSegments.size > 0) {
      x['segments'] = rootSegments.toJSON();
    }
    let {segmentEquivalences} = this.displayState;
    if (segmentEquivalences.size > 0) {
      x['equivalences'] = segmentEquivalences.toJSON();
    }
    x['transform'] = this.displayState.objectToDataTransform.toJSON();
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

  makeDropdown(element: HTMLDivElement) { return new SegmentationDropdown(element, this); }

  mergeSelection () {
    const {visibleSegments2D, segmentEquivalences} = this.displayState;

    let segids : Uint64[] = [];
    for (let segid of visibleSegments2D) {
      segids.push(segid.clone());
    }
    let strings = segids.map( (seg64) => seg64.toString() ); // uint64s are emulated 

    mergeNodes(strings).then( () => {
      let seg0 = <Uint64>segids.pop();
      segids.forEach((segid) => {
        segmentEquivalences.link(seg0, segid);
      });
    });

    StatusMessage.displayText('Merged visible segments.');
  }

  selectSegment () {
    let {segmentSelectionState} = this.displayState;
    if (!segmentSelectionState.hasSelectedSegment) {
      return;
    }
    
    let segment = this.displayState.shattered 
      ? segmentSelectionState.rawSelectedSegment
      : segmentSelectionState.selectedSegment;

    let {rootSegments, visibleSegments2D, visibleSegments3D, segmentEquivalences} = this.displayState;
    if (visibleSegments2D.has(segment)) {
      getRoot(segment).then(rootSegment => {
        rootSegments.delete(rootSegment);
        visibleSegments3D.delete(rootSegment);
      }).catch(e => handleDisabledGraphServer(e));
    }
    else {
      getRoot(segment).then(rootSegment => {
        rootSegments.add(rootSegment);
        visibleSegments3D.add(rootSegment);
      }).catch(e => handleDisabledGraphServer(e));
    }
  }

  splitSelectFirst () {
    let {segmentSelectionState} = this.displayState;
    if (segmentSelectionState.hasSelectedSegment) {
      let segment : Uint64 = <Uint64>segmentSelectionState.rawSelectedSegment;
      this.splitPartitions.sources.push(segment.clone());

      StatusMessage.displayText(`Selected ${segment} as source. Pick a sink.`);
    }
  }

  splitSelectSecond () {
    let {segmentSelectionState} = this.displayState;
    if (!segmentSelectionState.hasSelectedSegment) {
      return;
    }
    
    let segment : Uint64 = <Uint64>segmentSelectionState.rawSelectedSegment;
    this.splitPartitions.sinks.push(segment.clone());

    splitObject(this.splitPartitions.sources, this.splitPartitions.sinks)
      .then((splitgroups) => {
        this.displayState.segmentEquivalences.split(splitgroups[0], splitgroups[1]);
      }, (error) => {
        StatusMessage.displayText(error)
      });

    // Reset
    this.splitPartitions.sources.length = 0;
    this.splitPartitions.sinks.length = 0;
  }

  triggerRedraw() { //FIXME there should be a better way of doing this
    if (this.meshLayer) {
      this.meshLayer.redrawNeeded.dispatch();
    }
    for (let rl of this.renderLayers) {
      rl.redrawNeeded.dispatch();
    }
  }

  handleAction(action: string) {
    let actions: { [key:string] : Function } = {
      'recolor': () => this.displayState.segmentColorHash.randomize(),
      'clear-segments': () => {
        this.displayState.rootSegments.clear(),
        this.displayState.visibleSegments2D.clear(),
        this.displayState.visibleSegments3D.clear()
      },
      'merge-selection': this.mergeSelection,
      'select': this.selectSegment,
      'split-select-first': this.splitSelectFirst,
      'split-select-second': this.splitSelectSecond,
      'toggle-shatter-equivalencies': () => { 
        this.displayState.shattered = !this.displayState.shattered;
        let msg = this.displayState.shattered 
          ? 'Shatter ON'
          : 'Shatter OFF';
        StatusMessage.displayText(msg);
      },
      'toggle-semantic-mode': () => {
        this.displayState.semanticMode = !this.displayState.semanticMode;
        let msg = this.displayState.semanticMode 
          ? 'Semantic mode ON'
          : 'Semantic mode OFF';

        StatusMessage.displayText(msg);

      },
    };

    let fn : Function = actions[action];

    if (fn) {
      fn.call(this);
    }
  }
}

class SegmentationDropdown extends UserLayerDropdown {
  visibleSegmentWidget = this.registerDisposer(new SegmentSetWidget(this.layer.displayState));
  addSegmentWidget = this.registerDisposer(new Uint64EntryWidget());
  addSemanticWidget = this.registerDisposer(new SemanticEntryWidget(this.layer.displayState));

  selectedAlphaWidget =
      this.registerDisposer(new RangeWidget(this.layer.displayState.selectedAlpha));
  notSelectedAlphaWidget =
      this.registerDisposer(new RangeWidget(this.layer.displayState.notSelectedAlpha));
  objectAlphaWidget = this.registerDisposer(new RangeWidget(this.layer.displayState.objectAlpha));
  constructor(public element: HTMLDivElement, public layer: SegmentationUserLayer) {
    super();
    element.classList.add('segmentation-dropdown');
    let {selectedAlphaWidget, notSelectedAlphaWidget, objectAlphaWidget} = this;
    selectedAlphaWidget.promptElement.textContent = 'Opacity (on)';
    notSelectedAlphaWidget.promptElement.textContent = 'Opacity (off)';
    objectAlphaWidget.promptElement.textContent = 'Opacity (3d)';

    element.appendChild(this.selectedAlphaWidget.element);
    element.appendChild(this.notSelectedAlphaWidget.element);
    element.appendChild(this.objectAlphaWidget.element);
    element.appendChild(this.registerDisposer(this.addSemanticWidget).element);
    this.registerSignalBinding(this.addSemanticWidget.semanticUpdated.add(
      () => { this.layer.triggerRedraw(); }
    ));

    this.addSegmentWidget.element.classList.add('add-segment');
    this.addSegmentWidget.element.title = 'Add segment ID';
    element.appendChild(this.registerDisposer(this.addSegmentWidget).element);
    this.registerSignalBinding(this.addSegmentWidget.valueEntered.add(
      (value: Uint64) => {
        getRoot(value).then(rootSegment => {
          this.layer.displayState.rootSegments.add(rootSegment);
        }).catch(e => handleDisabledGraphServer(e));
      }
    ));

    element.appendChild(this.registerDisposer(this.visibleSegmentWidget).element);
  }
}

registerLayerType('segmentation', SegmentationUserLayer);
registerVolumeLayerType(VolumeType.SEGMENTATION, SegmentationUserLayer);
