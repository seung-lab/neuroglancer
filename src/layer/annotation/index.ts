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

import "#src/layer/annotation/style.css";

import type { AnnotationDisplayState } from "#src/annotation/annotation_layer_state.js";
import { AnnotationLayerState } from "#src/annotation/annotation_layer_state.js";
import { MultiscaleAnnotationSource } from "#src/annotation/frontend_source.js";
import type { AnnotationPropertySpec } from "#src/annotation/index.js";
import {
  annotationPropertySpecsToJson,
  AnnotationType,
  LocalAnnotationSource,
  parseAnnotationPropertySpecs,
} from "#src/annotation/index.js";
import type { CoordinateTransformSpecification } from "#src/coordinate_transform.js";
import { makeCoordinateSpace } from "#src/coordinate_transform.js";
import type { DataSourceSpecification } from "#src/datasource/index.js";
import { localAnnotationsUrl, LocalDataSource } from "#src/datasource/index.js";
import type { LayerManager, ManagedUserLayer } from "#src/layer/index.js";
import {
  LayerReference,
  registerLayerType,
  registerLayerTypeDetector,
  UserLayer,
} from "#src/layer/index.js";
import type { LoadedDataSubsource } from "#src/layer/layer_data_source.js";
import { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import { Overlay } from "#src/overlay.js";
import { getWatchableRenderLayerTransform } from "#src/render_coordinate_transform.js";
import { RenderLayerRole } from "#src/renderlayer.js";
import type { SegmentationDisplayState } from "#src/segmentation_display_state/frontend.js";
import type { TrackableBoolean } from "#src/trackable_boolean.js";
import { TrackableBooleanCheckbox } from "#src/trackable_boolean.js";
import {
  makeCachedLazyDerivedWatchableValue,
  TrackableValue,
} from "#src/trackable_value.js";
import type {
  AnnotationLayerView,
  MergedAnnotationStates,
} from "#src/ui/annotations.js";
import { UserLayerWithAnnotationsMixin } from "#src/ui/annotations.js";
import type { ToolActivation } from "#src/ui/tool.js";
import {
  LayerTool,
  makeToolButton,
  registerTool,
  unregisterTool,
} from "#src/ui/tool.js";
import { animationFrameDebounce } from "#src/util/animation_frame_debounce.js";
import type { Borrowed, Owned } from "#src/util/disposable.js";
import { RefCounted } from "#src/util/disposable.js";
import { updateChildren } from "#src/util/dom.js";
import {
  parseArray,
  parseFixedLengthArray,
  stableStringify,
  verify3dVec,
  verifyFinitePositiveFloat,
  verifyObject,
  verifyOptionalObjectProperty,
  verifyString,
  verifyStringArray,
} from "#src/util/json.js";
import { NullarySignal } from "#src/util/signal.js";
import { makeAddButton } from "#src/widget/add_button.js";
import { makeDeleteButton } from "#src/widget/delete_button.js";
import { DependentViewWidget } from "#src/widget/dependent_view_widget.js";
import { makeHelpButton } from "#src/widget/help_button.js";
import { LayerReferenceWidget } from "#src/widget/layer_reference.js";
import { makeMaximizeButton } from "#src/widget/maximize_button.js";
import { RenderScaleWidget } from "#src/widget/render_scale_widget.js";
import { ShaderCodeWidget } from "#src/widget/shader_code_widget.js";
import {
  registerLayerShaderControlsTool,
  ShaderControls,
} from "#src/widget/shader_controls.js";
import { Tab } from "#src/widget/tab_view.js";
import type { VirtualListSource } from "#src/widget/virtual_list.js";
import { VirtualList } from "#src/widget/virtual_list.js";

const POINTS_JSON_KEY = "points";
const ANNOTATIONS_JSON_KEY = "annotations";
const TAGS_JSON_KEY = "tags";
const ANNOTATION_PROPERTIES_JSON_KEY = "annotationProperties";
const ANNOTATION_RELATIONSHIPS_JSON_KEY = "annotationRelationships";
const CROSS_SECTION_RENDER_SCALE_JSON_KEY = "crossSectionAnnotationSpacing";
const PROJECTION_RENDER_SCALE_JSON_KEY = "projectionAnnotationSpacing";
const SHADER_JSON_KEY = "shader";
const SHADER_CONTROLS_JSON_KEY = "shaderControls";

function addPointAnnotations(annotations: LocalAnnotationSource, obj: any) {
  if (obj === undefined) {
    return;
  }
  parseArray(obj, (x, i) => {
    annotations.add({
      type: AnnotationType.POINT,
      id: "" + i,
      point: verify3dVec(x),
      properties: [],
    });
  });
}

function isValidLinkedSegmentationLayer(layer: ManagedUserLayer) {
  const userLayer = layer.layer;
  if (userLayer === null) {
    return true;
  }
  if (userLayer instanceof SegmentationUserLayer) {
    return true;
  }
  return false;
}

function getSegmentationDisplayState(
  layer: ManagedUserLayer | undefined,
): SegmentationDisplayState | null {
  if (layer === undefined) {
    return null;
  }
  const userLayer = layer.layer;
  if (userLayer === null) {
    return null;
  }
  if (!(userLayer instanceof SegmentationUserLayer)) {
    return null;
  }
  return userLayer.displayState;
}

interface LinkedSegmentationLayer {
  layerRef: Owned<LayerReference>;
  showMatches: TrackableBoolean;
  seenGeneration: number;
}

const LINKED_SEGMENTATION_LAYER_JSON_KEY = "linkedSegmentationLayer";
const FILTER_BY_SEGMENTATION_JSON_KEY = "filterBySegmentation";
const IGNORE_NULL_SEGMENT_FILTER_JSON_KEY = "ignoreNullSegmentFilter";

class LinkedSegmentationLayers extends RefCounted {
  changed = new NullarySignal();
  private curGeneration = -1;
  private wasLoading: boolean | undefined = undefined;
  constructor(
    public layerManager: Borrowed<LayerManager>,
    public annotationStates: Borrowed<MergedAnnotationStates>,
    public annotationDisplayState: Borrowed<AnnotationDisplayState>,
  ) {
    super();
    this.registerDisposer(annotationStates.changed.add(() => this.update()));
    this.registerDisposer(
      annotationStates.isLoadingChanged.add(() => this.update()),
    );
    this.update();
  }

  private update() {
    const generation = this.annotationStates.changed.count;
    const isLoading = this.annotationStates.isLoading;
    if (this.curGeneration === generation && isLoading === this.wasLoading)
      return;
    this.wasLoading = isLoading;
    this.curGeneration = generation;
    const { map } = this;
    let changed = false;
    for (const relationship of this.annotationStates.relationships) {
      let state = map.get(relationship);
      if (state === undefined) {
        state = this.addRelationship(relationship);
        changed = true;
      }
      state.seenGeneration = generation;
    }
    if (!isLoading) {
      const { relationshipStates } = this.annotationDisplayState;
      for (const [relationship, state] of map) {
        if (state.seenGeneration !== generation) {
          map.delete(relationship);
          relationshipStates.delete(relationship);
          changed = true;
        }
      }
    }
    if (changed) {
      this.changed.dispatch();
    }
  }

  private addRelationship(relationship: string): LinkedSegmentationLayer {
    const relationshipState =
      this.annotationDisplayState.relationshipStates.get(relationship);
    const layerRef = new LayerReference(
      this.layerManager.addRef(),
      isValidLinkedSegmentationLayer,
    );
    layerRef.registerDisposer(
      layerRef.changed.add(() => {
        relationshipState.segmentationState.value =
          layerRef.layerName === undefined
            ? undefined
            : getSegmentationDisplayState(layerRef.layer);
      }),
    );
    const { showMatches } = relationshipState;
    const state = {
      layerRef,
      showMatches,
      seenGeneration: -1,
    };
    layerRef.changed.add(this.changed.dispatch);
    showMatches.changed.add(this.changed.dispatch);
    this.map.set(relationship, state);
    return state;
  }

  get(relationship: string): LinkedSegmentationLayer {
    this.update();
    return this.map.get(relationship)!;
  }

  private unbind(state: LinkedSegmentationLayer) {
    state.layerRef.changed.remove(this.changed.dispatch);
    state.showMatches.changed.remove(this.changed.dispatch);
  }

  reset() {
    for (const state of this.map.values()) {
      state.showMatches.reset();
    }
  }

  toJSON() {
    const { map } = this;
    if (map.size === 0) return {};
    let linkedJson: { [relationship: string]: string } | undefined = undefined;
    const filterBySegmentation = [];
    for (const [name, state] of map) {
      if (state.showMatches.value) {
        filterBySegmentation.push(name);
      }
      const { layerName } = state.layerRef;
      if (layerName !== undefined) {
        (linkedJson = linkedJson || {})[name] = layerName;
      }
    }
    filterBySegmentation.sort();
    return {
      [LINKED_SEGMENTATION_LAYER_JSON_KEY]: linkedJson,
      [FILTER_BY_SEGMENTATION_JSON_KEY]:
        filterBySegmentation.length === 0 ? undefined : filterBySegmentation,
    };
  }
  restoreState(json: any) {
    const { isLoading } = this.annotationStates;
    verifyOptionalObjectProperty(
      json,
      LINKED_SEGMENTATION_LAYER_JSON_KEY,
      (linkedJson) => {
        if (typeof linkedJson === "string") {
          linkedJson = { segments: linkedJson };
        }
        verifyObject(linkedJson);
        for (const key of Object.keys(linkedJson)) {
          const value = verifyString(linkedJson[key]);
          let state = this.map.get(key);
          if (state === undefined) {
            if (!isLoading) continue;
            state = this.addRelationship(key);
          }
          state.layerRef.layerName = value;
        }
        for (const [relationship, state] of this.map) {
          if (!Object.prototype.hasOwnProperty.call(linkedJson, relationship)) {
            state.layerRef.layerName = undefined;
          }
        }
      },
    );
    verifyOptionalObjectProperty(
      json,
      FILTER_BY_SEGMENTATION_JSON_KEY,
      (filterJson) => {
        if (typeof filterJson === "boolean") {
          filterJson = filterJson === true ? ["segments"] : [];
        }
        for (const key of verifyStringArray(filterJson)) {
          let state = this.map.get(key);
          if (state === undefined) {
            if (!isLoading) continue;
            state = this.addRelationship(key);
          }
          state.showMatches.value = true;
        }
      },
    );
  }

  disposed() {
    const { map } = this;
    for (const state of map.values()) {
      this.unbind(state);
    }
    map.clear();
    super.disposed();
  }
  private map = new Map<string, LinkedSegmentationLayer>();
}

class LinkedSegmentationLayerWidget extends RefCounted {
  element = document.createElement("label");
  seenGeneration = -1;
  constructor(
    public relationship: string,
    public state: LinkedSegmentationLayer,
  ) {
    super();
    const { element } = this;
    const checkboxWidget = this.registerDisposer(
      new TrackableBooleanCheckbox(state.showMatches),
    );
    const layerWidget = new LayerReferenceWidget(state.layerRef);
    element.appendChild(checkboxWidget.element);
    element.appendChild(document.createTextNode(relationship));
    element.appendChild(layerWidget.element);
  }
}

class LinkedSegmentationLayersWidget extends RefCounted {
  widgets = new Map<string, LinkedSegmentationLayerWidget>();
  element = document.createElement("div");
  constructor(public linkedSegmentationLayers: LinkedSegmentationLayers) {
    super();
    this.element.style.display = "contents";
    const debouncedUpdateView = this.registerCancellable(
      animationFrameDebounce(() => this.updateView()),
    );
    this.registerDisposer(
      this.linkedSegmentationLayers.annotationStates.changed.add(
        debouncedUpdateView,
      ),
    );
    this.updateView();
  }

  private updateView() {
    const { linkedSegmentationLayers } = this;
    const { annotationStates } = linkedSegmentationLayers;
    const generation = annotationStates.changed.count;
    const { widgets } = this;
    function* getChildren(this: LinkedSegmentationLayersWidget) {
      for (const relationship of annotationStates.relationships) {
        let widget = widgets.get(relationship);
        if (widget === undefined) {
          widget = new LinkedSegmentationLayerWidget(
            relationship,
            linkedSegmentationLayers.get(relationship),
          );
        }
        widget.seenGeneration = generation;
        yield widget.element;
      }
    }
    for (const [relationship, widget] of widgets) {
      if (widget.seenGeneration !== generation) {
        widget.dispose();
        widgets.delete(relationship);
      }
    }
    updateChildren(this.element, getChildren.call(this));
  }

  disposed() {
    super.disposed();
    for (const widget of this.widgets.values()) {
      widget.dispose();
    }
  }
}

const TOOL_ID = "foofoofoo";

class TagTool extends LayerTool<AnnotationUserLayer> {
  constructor(
    public tag: string,
    layer: AnnotationUserLayer,
    toggle?: boolean,
  ) {
    super(layer, toggle);
  }

  activate(activation: ToolActivation<this>) {
    console.log("I want to tag", this.tag);
    const { localAnnotations } = this.layer;
    if (localAnnotations) {
      const ourSelectionState =
        this.layer.manager.root.selectionState.value?.layers.find(
          (x) => x.layer === this.layer,
        );
      if (ourSelectionState && ourSelectionState.state.annotationId) {
        console.log("annotationId", ourSelectionState.state.annotationId);
        const identifier = `tag_${this.tag}`;
        const existing = localAnnotations.properties.find(
          (x) => x.identifier === identifier,
        );
        if (!existing) {
          localAnnotations.addProperty({
            type: "uint8",
            tag: true,
            enumValues: [0, 1],
            enumLabels: ["", this.tag],
            default: 0,
            description: this.tag,
            identifier,
          });
          localAnnotations.changed.dispatch();
          // this.layer.specificationChanged.dispatch(); // add property to JSON (or we could create the properties from the tags which might ensure greater consistency)
        }

        const annotation = localAnnotations.get(
          ourSelectionState.state.annotationId,
        );

        if (annotation) {
          console.log("annotation", annotation);
          const propertyIndex = localAnnotations.properties.findIndex(
            (x) => x.identifier === identifier,
          );
          if (propertyIndex > -1) {
            annotation.properties[propertyIndex] =
              1 - annotation.properties[propertyIndex];
            localAnnotations.changed.dispatch();
            this.layer.manager.root.selectionState.changed.dispatch(); // TODO, this is probably not the best way to handle it
          }
        }
      }
    }
    activation.cancel();
  }

  toJSON() {
    return `${TOOL_ID}_${this.tag}`;
  }

  get description() {
    return `tag ${this.tag}`;
  }
}

class TagsTab extends Tab {
  // private layerView = this.registerDisposer(
  //   new AnnotationLayerView(this.layer, this.layer.annotationDisplayState),
  // );

  tools = new Set<string>();

  constructor(public layer: Borrowed<AnnotationUserLayer>) {
    super();
    const { element } = this;
    element.classList.add("neuroglancer-tags-tab");
    // element.appendChild(this.layerView.element);

    const { tags } = layer;

    const addTagControl = document.createElement("div");
    addTagControl.classList.add("neuroglancer-add-tag-control");
    const inputElement = document.createElement("input");
    inputElement.required = true;
    const addNewTagButton = makeAddButton({
      title: "Add additional tag",
      onClick: () => {
        const { value } = inputElement;
        if (inputElement.validity.valid && !tags.value.includes(value)) {
          tags.value.push(value);
          tags.changed.dispatch();
        }
      },
    });
    addTagControl.appendChild(inputElement);
    addTagControl.appendChild(addNewTagButton);
    element.appendChild(addTagControl);

    const tagsContainer = document.createElement("div");
    element.appendChild(tagsContainer);

    const listSource: VirtualListSource = {
      length: tags.value.length,
      render: (index: number) => {
        const el = document.createElement("div");
        const tag = tags.value[index];
        const tool = makeToolButton(this, layer.toolBinder, {
          toolJson: `${TOOL_ID}_${tag}`,
          label: tag,
          title: `Tag selected annotation with ${tag}`,
        });
        el.append(tool);
        const deleteButton = makeDeleteButton({
          title: "Delete tag",
          onClick: (event) => {
            event.stopPropagation();
            event.preventDefault();
            tags.value = tags.value.filter((x) => x !== tag);
          },
        });
        el.append(deleteButton);
        return el;
      },
      changed: new NullarySignal(),
    };

    const list = this.registerDisposer(
      new VirtualList({
        source: listSource,
      }),
    );
    element.appendChild(list.element);

    this.registerDisposer(
      tags.changed.add(() => {
        listSource.length = tags.value.length;
        listSource.changed!.dispatch([
          {
            retainCount: 0,
            deleteCount: 0,
            insertCount: listSource.length,
          },
        ]);
      }),
    );
    tags.changed.dispatch();
  }
}

const Base = UserLayerWithAnnotationsMixin(UserLayer);
export class AnnotationUserLayer extends Base {
  localAnnotations: LocalAnnotationSource | undefined;
  private localAnnotationProperties: AnnotationPropertySpec[] | undefined;
  private localAnnotationRelationships: string[];
  private localAnnotationsJson: any = undefined;
  private pointAnnotationsJson: any = undefined;
  tags: TrackableValue<string[]> = new TrackableValue([], verifyStringArray);
  linkedSegmentationLayers = this.registerDisposer(
    new LinkedSegmentationLayers(
      this.manager.rootLayers,
      this.annotationStates,
      this.annotationDisplayState,
    ),
  );

  disposed() {
    const { localAnnotations } = this;
    if (localAnnotations !== undefined) {
      localAnnotations.dispose();
    }
    super.disposed();
  }

  constructor(managedLayer: Borrowed<ManagedUserLayer>) {
    super(managedLayer);
    this.linkedSegmentationLayers.changed.add(
      this.specificationChanged.dispatch,
    );
    this.annotationDisplayState.ignoreNullSegmentFilter.changed.add(
      this.specificationChanged.dispatch,
    );
    this.annotationCrossSectionRenderScaleTarget.changed.add(
      this.specificationChanged.dispatch,
    );
    this.annotationProjectionRenderScaleTarget.changed.add(
      this.specificationChanged.dispatch,
    );
    const registeredTools = new Set<string>();

    this.tags.changed.add(() => {
      for (const tag of this.tags.value) {
        if (!registeredTools.has(tag)) {
          registerTool(AnnotationUserLayer, `${TOOL_ID}_${tag}`, (layer) => {
            return new TagTool(tag, layer, true);
          });
          registeredTools.add(tag);
        }
      }
      for (const tag of registeredTools) {
        if (!this.tags.value.includes(tag)) {
          unregisterTool(AnnotationUserLayer, `${TOOL_ID}_${tag}`);
          registeredTools.delete(tag);

          for (const [key, tool] of this.toolBinder.bindings.entries()) {
            if (tool instanceof TagTool && tool.tag === tag) {
              this.toolBinder.deleteTool(key);
            }
          }

          console.log("local bindings", this.toolBinder.bindings);
        }
      }
      this.specificationChanged.dispatch();
    });
    this.tabs.add("rendering", {
      label: "Rendering",
      order: -100,
      getter: () => new RenderingOptionsTab(this),
    });
    this.tabs.default = "annotations";
    this.tabs.add("tags", {
      label: "Tags",
      order: 10,
      getter: () => new TagsTab(this),
    });
  }

  restoreState(specification: any) {
    console.log("restore state of annotation source");
    // restore tags before super so tag tools are registered
    this.tags.restoreState(specification[TAGS_JSON_KEY] || []);
    super.restoreState(specification);
    this.linkedSegmentationLayers.restoreState(specification);
    this.localAnnotationsJson = specification[ANNOTATIONS_JSON_KEY];
    // this.tags = verifyOptionalObjectProperty(specification, TAGS_JSON_KEY, verifyStringArray);
    this.localAnnotationProperties = verifyOptionalObjectProperty(
      specification,
      ANNOTATION_PROPERTIES_JSON_KEY,
      parseAnnotationPropertySpecs,
    );
    this.localAnnotationRelationships = verifyOptionalObjectProperty(
      specification,
      ANNOTATION_RELATIONSHIPS_JSON_KEY,
      verifyStringArray,
      ["segments"],
    );
    this.pointAnnotationsJson = specification[POINTS_JSON_KEY];
    this.annotationCrossSectionRenderScaleTarget.restoreState(
      specification[CROSS_SECTION_RENDER_SCALE_JSON_KEY],
    );
    this.annotationProjectionRenderScaleTarget.restoreState(
      specification[PROJECTION_RENDER_SCALE_JSON_KEY],
    );
    this.annotationDisplayState.ignoreNullSegmentFilter.restoreState(
      specification[IGNORE_NULL_SEGMENT_FILTER_JSON_KEY],
    );
    this.annotationDisplayState.shader.restoreState(
      specification[SHADER_JSON_KEY],
    );
    this.annotationDisplayState.shaderControls.restoreState(
      specification[SHADER_CONTROLS_JSON_KEY],
    );
  }

  getLegacyDataSourceSpecifications(
    sourceSpec: any,
    layerSpec: any,
    legacyTransform: CoordinateTransformSpecification | undefined,
    explicitSpecs: DataSourceSpecification[],
  ): DataSourceSpecification[] {
    if (Object.prototype.hasOwnProperty.call(layerSpec, "source")) {
      return super.getLegacyDataSourceSpecifications(
        sourceSpec,
        layerSpec,
        legacyTransform,
        explicitSpecs,
      );
    }
    const scales = verifyOptionalObjectProperty(
      layerSpec,
      "voxelSize",
      (voxelSizeObj) =>
        parseFixedLengthArray(
          new Float64Array(3),
          voxelSizeObj,
          (x) => verifyFinitePositiveFloat(x) / 1e9,
        ),
    );
    const units = ["m", "m", "m"];
    if (scales !== undefined) {
      const inputSpace = makeCoordinateSpace({
        rank: 3,
        units,
        scales,
        names: ["x", "y", "z"],
      });
      if (legacyTransform === undefined) {
        legacyTransform = {
          outputSpace: inputSpace,
          sourceRank: 3,
          transform: undefined,
          inputSpace,
        };
      } else {
        legacyTransform = {
          ...legacyTransform,
          inputSpace,
        };
      }
    }
    return [
      {
        url: localAnnotationsUrl,
        transform: legacyTransform,
        enableDefaultSubsources: true,
        subsources: new Map(),
      },
    ];
  }

  activateDataSubsources(subsources: Iterable<LoadedDataSubsource>) {
    let hasLocalAnnotations = false;
    let properties: AnnotationPropertySpec[] | undefined;
    for (const loadedSubsource of subsources) {
      const { subsourceEntry } = loadedSubsource;
      const { local } = subsourceEntry.subsource;
      const setProperties = (newProperties: AnnotationPropertySpec[]) => {
        if (
          properties !== undefined &&
          stableStringify(newProperties) !== stableStringify(properties)
        ) {
          loadedSubsource.deactivate(
            "Annotation properties are not compatible",
          );
          return false;
        }
        properties = newProperties;
        return true;
      };
      if (local === LocalDataSource.annotations) {
        if (hasLocalAnnotations) {
          loadedSubsource.deactivate(
            "Only one local annotations source per layer is supported",
          );
          continue;
        }
        hasLocalAnnotations = true;
        if (!setProperties(this.localAnnotationProperties ?? [])) continue;
        loadedSubsource.activate((refCounted) => {
          const localAnnotations = (this.localAnnotations =
            new LocalAnnotationSource(
              loadedSubsource.loadedDataSource.transform,
              this.localAnnotationProperties ?? [],
              this.localAnnotationRelationships,
            ));
          try {
            localAnnotations.restoreState(this.localAnnotationsJson);
          } catch {
            // Ignore errors from malformed local annotations.
          }
          refCounted.registerDisposer(() => {
            localAnnotations.dispose();
            this.localAnnotations = undefined;
          });
          refCounted.registerDisposer(
            this.localAnnotations.changed.add(() => {
              this.localAnnotationProperties =
                this.localAnnotations?.properties;
              this.specificationChanged.dispatch();
            }),
          );
          try {
            addPointAnnotations(
              this.localAnnotations,
              this.pointAnnotationsJson,
            );
          } catch {
            // Ignore errors from malformed point annotations.
          }
          this.pointAnnotationsJson = undefined;
          this.localAnnotationsJson = undefined;
          const state = new AnnotationLayerState({
            localPosition: this.localPosition,
            transform: refCounted.registerDisposer(
              getWatchableRenderLayerTransform(
                this.manager.root.coordinateSpace,
                this.localPosition.coordinateSpace,
                loadedSubsource.loadedDataSource.transform,
                undefined,
              ),
            ),
            source: localAnnotations.addRef(),
            displayState: this.annotationDisplayState,
            dataSource: loadedSubsource.loadedDataSource.layerDataSource,
            subsourceIndex: loadedSubsource.subsourceIndex,
            subsourceId: subsourceEntry.id,
            role: RenderLayerRole.ANNOTATION,
          });
          this.addAnnotationLayerState(state, loadedSubsource);
        });
        continue;
      }
      const { annotation } = subsourceEntry.subsource;
      if (annotation !== undefined) {
        if (!setProperties(annotation.properties)) continue;
        loadedSubsource.activate(() => {
          const state = new AnnotationLayerState({
            localPosition: this.localPosition,
            transform: loadedSubsource.getRenderLayerTransform(),
            source: annotation,
            displayState: this.annotationDisplayState,
            dataSource: loadedSubsource.loadedDataSource.layerDataSource,
            subsourceIndex: loadedSubsource.subsourceIndex,
            subsourceId: subsourceEntry.id,
            role: RenderLayerRole.ANNOTATION,
          });
          this.addAnnotationLayerState(state, loadedSubsource);
        });
        continue;
      }
      loadedSubsource.deactivate("Not compatible with annotation layer");
    }
    const prevAnnotationProperties =
      this.annotationDisplayState.annotationProperties.value;
    if (
      stableStringify(prevAnnotationProperties) !== stableStringify(properties)
    ) {
      this.annotationDisplayState.annotationProperties.value = properties;
    }
  }

  initializeAnnotationLayerViewTab(tab: AnnotationLayerView) {
    const hasChunkedSource = tab.registerDisposer(
      makeCachedLazyDerivedWatchableValue(
        (states) =>
          states.some((x) => x.source instanceof MultiscaleAnnotationSource),
        this.annotationStates,
      ),
    );
    const renderScaleControls = tab.registerDisposer(
      new DependentViewWidget(
        hasChunkedSource,
        (hasChunkedSource, parent, refCounted) => {
          if (!hasChunkedSource) return;
          {
            const renderScaleWidget = refCounted.registerDisposer(
              new RenderScaleWidget(
                this.annotationCrossSectionRenderScaleHistogram,
                this.annotationCrossSectionRenderScaleTarget,
              ),
            );
            renderScaleWidget.label.textContent = "Spacing (cross section)";
            parent.appendChild(renderScaleWidget.element);
          }
          {
            const renderScaleWidget = refCounted.registerDisposer(
              new RenderScaleWidget(
                this.annotationProjectionRenderScaleHistogram,
                this.annotationProjectionRenderScaleTarget,
              ),
            );
            renderScaleWidget.label.textContent = "Spacing (projection)";
            parent.appendChild(renderScaleWidget.element);
          }
        },
      ),
    );
    tab.element.insertBefore(
      renderScaleControls.element,
      tab.element.firstChild,
    );
    {
      const checkbox = tab.registerDisposer(
        new TrackableBooleanCheckbox(
          this.annotationDisplayState.ignoreNullSegmentFilter,
        ),
      );
      const label = document.createElement("label");
      label.appendChild(
        document.createTextNode("Ignore null related segment filter"),
      );
      label.title =
        "Display all annotations if filtering by related segments is enabled but no segments are selected";
      label.appendChild(checkbox.element);
      tab.element.appendChild(label);
    }
    tab.element.appendChild(
      tab.registerDisposer(
        new LinkedSegmentationLayersWidget(this.linkedSegmentationLayers),
      ).element,
    );
  }

  toJSON() {
    const x = super.toJSON();
    x[CROSS_SECTION_RENDER_SCALE_JSON_KEY] =
      this.annotationCrossSectionRenderScaleTarget.toJSON();
    x[PROJECTION_RENDER_SCALE_JSON_KEY] =
      this.annotationProjectionRenderScaleTarget.toJSON();
    if (this.localAnnotations !== undefined) {
      x[ANNOTATIONS_JSON_KEY] = this.localAnnotations.toJSON();
    } else if (this.localAnnotationsJson !== undefined) {
      x[ANNOTATIONS_JSON_KEY] = this.localAnnotationsJson;
    }
    x[ANNOTATION_PROPERTIES_JSON_KEY] = annotationPropertySpecsToJson(
      this.localAnnotationProperties,
    );
    const { localAnnotationRelationships } = this;
    x[ANNOTATION_RELATIONSHIPS_JSON_KEY] =
      localAnnotationRelationships.length === 1 &&
      localAnnotationRelationships[0] === "segments"
        ? undefined
        : localAnnotationRelationships;
    x[IGNORE_NULL_SEGMENT_FILTER_JSON_KEY] =
      this.annotationDisplayState.ignoreNullSegmentFilter.toJSON();
    x[SHADER_JSON_KEY] = this.annotationDisplayState.shader.toJSON();
    x[SHADER_CONTROLS_JSON_KEY] =
      this.annotationDisplayState.shaderControls.toJSON();
    Object.assign(x, this.linkedSegmentationLayers.toJSON());
    if (this.tabs.value?.length) {
      x[TAGS_JSON_KEY] = this.tags.toJSON();
    }
    return x;
  }

  static type = "annotation";
  static typeAbbreviation = "ann";
}

function makeShaderCodeWidget(layer: AnnotationUserLayer) {
  return new ShaderCodeWidget({
    shaderError: layer.annotationDisplayState.shaderError,
    fragmentMain: layer.annotationDisplayState.shader,
    shaderControlState: layer.annotationDisplayState.shaderControls,
  });
}

class ShaderCodeOverlay extends Overlay {
  codeWidget = this.registerDisposer(makeShaderCodeWidget(this.layer));
  constructor(public layer: AnnotationUserLayer) {
    super();
    this.content.appendChild(this.codeWidget.element);
    this.codeWidget.textEditor.refresh();
  }
}

class RenderingOptionsTab extends Tab {
  codeWidget = this.registerDisposer(makeShaderCodeWidget(this.layer));
  constructor(public layer: AnnotationUserLayer) {
    super();
    const { element } = this;
    element.classList.add("neuroglancer-annotation-rendering-tab");
    element.appendChild(
      this.registerDisposer(
        new DependentViewWidget(
          layer.annotationDisplayState.annotationProperties,
          (properties, parent) => {
            if (properties === undefined || properties.length === 0) return;
            const propertyList = document.createElement("div");
            parent.appendChild(propertyList);
            propertyList.classList.add(
              "neuroglancer-annotation-shader-property-list",
            );
            for (const property of properties) {
              const div = document.createElement("div");
              div.classList.add("neuroglancer-annotation-shader-property");
              const typeElement = document.createElement("span");
              typeElement.classList.add(
                "neuroglancer-annotation-shader-property-type",
              );
              typeElement.textContent = property.type;
              const nameElement = document.createElement("span");
              nameElement.classList.add(
                "neuroglancer-annotation-shader-property-identifier",
              );
              nameElement.textContent = `prop_${property.identifier}`;
              div.appendChild(typeElement);
              div.appendChild(nameElement);
              const { description } = property;
              if (description !== undefined) {
                div.title = description;
              }
              propertyList.appendChild(div);
            }
          },
        ),
      ).element,
    );
    const topRow = document.createElement("div");
    topRow.className =
      "neuroglancer-segmentation-dropdown-skeleton-shader-header";
    const label = document.createElement("div");
    label.style.flex = "1";
    label.textContent = "Annotation shader:";
    topRow.appendChild(label);
    topRow.appendChild(
      makeMaximizeButton({
        title: "Show larger editor view",
        onClick: () => {
          new ShaderCodeOverlay(this.layer);
        },
      }),
    );
    topRow.appendChild(
      makeHelpButton({
        title: "Documentation on annotation rendering",
        href: "https://github.com/google/neuroglancer/blob/master/src/annotation/rendering.md",
      }),
    );
    element.appendChild(topRow);

    element.appendChild(this.codeWidget.element);
    element.appendChild(
      this.registerDisposer(
        new ShaderControls(
          layer.annotationDisplayState.shaderControls,
          this.layer.manager.root.display,
          this.layer,
          { visibility: this.visibility },
        ),
      ).element,
    );
  }
}

registerLayerType(AnnotationUserLayer);
registerLayerType(AnnotationUserLayer, "pointAnnotation");
registerLayerTypeDetector((subsource) => {
  if (subsource.local === LocalDataSource.annotations) {
    return { layerConstructor: AnnotationUserLayer, priority: 100 };
  }
  if (subsource.annotation !== undefined) {
    return { layerConstructor: AnnotationUserLayer, priority: 1 };
  }
  return undefined;
});

registerLayerShaderControlsTool(AnnotationUserLayer, (layer) => ({
  shaderControlState: layer.annotationDisplayState.shaderControls,
}));
