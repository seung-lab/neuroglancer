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
 * @file Support for rendering collections.
 */

import {Annotation, AnnotationReference, AnnotationSource, AnnotationType, Collection, LocalAnnotationSource} from 'neuroglancer/annotation';
import {PlaceAnnotationTool, TwoStepAnnotationTool} from 'neuroglancer/annotation/annotation';
import {PlaceBoundingBoxTool} from 'neuroglancer/annotation/bounding_box';
import {PlaceSphereTool} from 'neuroglancer/annotation/ellipsoid';
import {AnnotationLayerState} from 'neuroglancer/annotation/frontend';
import {PlaceLineTool} from 'neuroglancer/annotation/line';
import {PlaceLineStripTool} from 'neuroglancer/annotation/line_strip';
import {PlacePointTool} from 'neuroglancer/annotation/point';
import {PlaceSpokeTool} from 'neuroglancer/annotation/spoke';
import {AnnotationRenderContext, AnnotationRenderHelper, registerAnnotationTypeRenderHandler} from 'neuroglancer/annotation/type_handler';
import {MouseSelectionState} from 'neuroglancer/layer';
import {StatusMessage} from 'neuroglancer/status';
import {TrackableBoolean} from 'neuroglancer/trackable_boolean';
import {UserLayerWithAnnotations} from 'neuroglancer/ui/annotations';
import {registerTool} from 'neuroglancer/ui/tool';
import {mat4, vec3} from 'neuroglancer/util/geom';
import {CircleShader} from 'neuroglancer/webgl/circles';
import {emitterDependentShaderGetter, ShaderBuilder} from 'neuroglancer/webgl/shader';
// TODO: Collection annotations should not be rendered at all, if possible remove drawing code

const ANNOTATE_COLLECTION_TOOL_ID = 'annotateCollection';

class RenderHelper extends AnnotationRenderHelper {
  private circleShader = this.registerDisposer(new CircleShader(this.gl));
  private shaderGetter = emitterDependentShaderGetter(
      this, this.gl, (builder: ShaderBuilder) => this.defineShader(builder));

  defineShader(builder: ShaderBuilder) {
    super.defineShader(builder);
    this.circleShader.defineShader(builder, /*crossSectionFade=*/this.targetIsSliceView);
    // Position of point in camera coordinates.
    builder.addAttribute('highp vec3', 'aVertexPosition');
    builder.setVertexMain(`
 emitCircle(uProjection * vec4(aVertexPosition, 1.0));
 ${this.setPartIndex(builder)};
 `);
    builder.setFragmentMain(`
 vec4 borderColor = vec4(0.0, 0.0, 0.0, 1.0);
 emitAnnotation(getCircleColor(vColor, borderColor));
 `);
  }

  draw(context: AnnotationRenderContext) {
    const shader = this.shaderGetter(context.renderContext.emitter);
    this.enable(shader, context, () => {});
  }
}

registerAnnotationTypeRenderHandler(AnnotationType.COLLECTION, {
  bytes: 3 * 4,
  serializer: (buffer: ArrayBuffer, offset: number, numAnnotations: number) => {
    const coordinates = new Float32Array(buffer, offset, numAnnotations * 3);
    return (annotation: Collection, index: number) => {
      const {source} = annotation;
      const coordinateOffset = index * 3;
      coordinates[coordinateOffset] = source[0];
      coordinates[coordinateOffset + 1] = source[1];
      coordinates[coordinateOffset + 2] = source[2];
    };
  },
  sliceViewRenderHelper: RenderHelper,
  perspectiveViewRenderHelper: RenderHelper,
  pickIdsPerInstance: 1,
  snapPosition: (position: vec3, objectToData, data, offset) => {
    vec3.transformMat4(position, <vec3>new Float32Array(data, offset, 3), objectToData);
  },
  getRepresentativePoint: (objectToData, ann) => {
    let repPoint = vec3.create();
    vec3.transformMat4(repPoint, ann.source, objectToData);
    return repPoint;
  },
  updateViaRepresentativePoint: (oldAnnotation, position: vec3, dataToObject: mat4) => {
    let annotation = {...oldAnnotation};
    annotation.source = vec3.transformMat4(vec3.create(), position, dataToObject);
    // annotation.id = '';
    return annotation;
  }
});

export type MultiTool =
    typeof PlacePointTool|typeof PlaceBoundingBoxTool|typeof PlaceLineTool|typeof PlaceSphereTool|
    typeof PlaceLineStripTool|typeof PlaceSpokeTool|typeof MultiStepAnnotationTool;


export class MultiStepAnnotationTool extends PlaceAnnotationTool {
  inProgressAnnotation:
      {annotationLayer: AnnotationLayerState, reference: AnnotationReference, disposer: () => void}|
      undefined;
  annotationType: AnnotationType.COLLECTION|AnnotationType.LINE_STRIP|AnnotationType.SPOKE;
  toolset: MultiTool;
  toolbox: HTMLDivElement;
  childTool: PlacePointTool|PlaceBoundingBoxTool|PlaceLineTool|PlaceSphereTool|PlaceLineStripTool|
      PlaceSpokeTool|undefined;
  constructor(public layer: UserLayerWithAnnotations, options: any) {
    super(layer, options);
    this.toolbox = options.toolbox;
  }

  updateLast() {
    const inprogress = this.inProgressAnnotation;
    if (inprogress && inprogress.reference.value) {
      const oldAnnotation = <Collection>inprogress.reference.value!;
      const lastB = oldAnnotation.lastA;
      const lastA = this.getChildRef();
      const newAnnotation = {...oldAnnotation, lastA, lastB};
      inprogress.annotationLayer.source.update(inprogress.reference, newAnnotation);
    }
  }

  getChildRef() {
    if (this.childTool && this.inProgressAnnotation) {
      const {entries} = <Collection>this.inProgressAnnotation.reference!.value!;
      return this.inProgressAnnotation.annotationLayer.source.getReference(
          entries[entries.length - 1]);
    }
    return;
  }

  appendNewChildAnnotation(
      oldAnnotationRef: AnnotationReference, mouseState: MouseSelectionState,
      spoofMouse?: MouseSelectionState) {
    // This function is only called by Collection Sub Classes with auto build: Spoke, LineStrip
    this.childTool = <any>new this.toolset(this.layer, {});
    this.childTool!.trigger(mouseState, oldAnnotationRef, spoofMouse);
    this.updateLast();
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

  trigger(mouseState: MouseSelectionState, parentRef?: AnnotationReference) {
    const {annotationLayer} = this;
    if (annotationLayer === undefined) {
      // Not yet ready.
      return;
    }
    if (!this.childTool) {
      // StatusMessage.showTemporaryMessage(`Collections require a child tool.`);
      return;
    }
    if (mouseState.active) {
      if (this.inProgressAnnotation === undefined || !this.inProgressAnnotation.reference.value) {
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
        this.updateLast();
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
        this.updateLast();
      }
    }
  }

  safeDelete(target: AnnotationReference) {
    const source = <AnnotationSource>this.inProgressAnnotation!.annotationLayer!.source;
    if (target) {
      if (source.isPending(target.id)) {
        target.dispose();
      } else {
        source.delete(target);
      }
    }
  }

  complete(shortcut?: boolean, killchild?: boolean): boolean {
    let isChildToolSet = false, hasChildren = false;
    if (this.inProgressAnnotation) {
      isChildToolSet = <boolean>!!this.childTool;
      const value = <any>this.inProgressAnnotation.reference.value;
      hasChildren = value && value.entries.length;
    }

    if (isChildToolSet || hasChildren) {
      if (shortcut) {
        const {lastA, lastB} = <any>this.inProgressAnnotation!.reference!.value!;
        this.safeDelete(lastA);
        this.safeDelete(lastB);
      }
      const nonPointTool = (<MultiStepAnnotationTool|TwoStepAnnotationTool>this.childTool!);
      const childInProgress = nonPointTool ? nonPointTool.inProgressAnnotation : void (0);
      const childCount = (<Collection>this.inProgressAnnotation!.reference.value!).entries.length;
      let isChildInProgressCollection = false;
      let collection: Collection;
      if (childInProgress) {
        collection = <Collection>childInProgress!.reference.value!;
        isChildInProgressCollection = <boolean>!!(collection && collection.entries);
      }
      const completeChild = (): boolean => {
        const success = (<MultiStepAnnotationTool>this.childTool!).complete(shortcut);
        if (killchild) {
          this.childTool!.dispose();
          this.childTool = undefined;
          this.layer.tool.changed.dispatch();
          this.layer.selectedAnnotation.changed.dispatch();

          let key = this.toolbox.querySelector('.neuroglancer-child-tool');
          if (key) {
            key.classList.remove('neuroglancer-child-tool');
          }
        }
        return success;
      };

      if (isChildInProgressCollection) {
        if (collection!.entries.length > 1) {
          const success = completeChild();
          if (success) {
            return success;
          }
        }
      }

      if ((!childInProgress && childCount === 1) || childCount > 1) {
        if (this.childTool) {
          this.childTool!.dispose();
        }
        const {reference, annotationLayer} = this.inProgressAnnotation!;
        annotationLayer.source.commit(reference);
        StatusMessage.showTemporaryMessage(
            `${reference.value!.pid ? 'Child a' : 'A'}nnotation ${reference.value!.id} complete.`);
        this.inProgressAnnotation!.disposer();
        this.inProgressAnnotation = undefined;
        this.layer.selectedAnnotation.changed.dispatch();
        return true;
      }
    }
    // To complete a collection, it must have at least one completed annotation. An annotation is
    // complete if it is not inProgress/pending or it is a point.
    // If the child tool is a collection, it is completed first. Once the child collection is
    // complete or cannot be completed (in which case it is ignored), then the collection can be
    // completed.
    StatusMessage.showTemporaryMessage(`No annotation has been made.`, 3000);
    return false;
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

registerTool(
    ANNOTATE_COLLECTION_TOOL_ID,
    (layer, options) => new MultiStepAnnotationTool(<UserLayerWithAnnotations>layer, options));
