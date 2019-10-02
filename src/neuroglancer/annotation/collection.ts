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

import {Annotation, AnnotationReference, AnnotationType, Collection, LineStrip, LocalAnnotationSource} from 'neuroglancer/annotation';
import {PlaceAnnotationTool, TwoStepAnnotationTool} from 'neuroglancer/annotation/annotation';
import {PlaceBoundingBoxTool} from 'neuroglancer/annotation/bounding_box';
import {PlaceSphereTool} from 'neuroglancer/annotation/ellipsoid';
import {AnnotationLayerState} from 'neuroglancer/annotation/frontend';
import {PlaceLineTool} from 'neuroglancer/annotation/line';
import {PlaceLineStripTool} from 'neuroglancer/annotation/line_strip';
import {PlacePointTool} from 'neuroglancer/annotation/point';
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
    this.enable(shader, context, () => {
      const {gl} = this;
      const aVertexPosition = shader.attribute('aVertexPosition');
      context.buffer.bindToVertexAttrib(
          aVertexPosition, /*components=*/3, /*attributeType=*/WebGL2RenderingContext.FLOAT,
          /*normalized=*/false,
          /*stride=*/0, /*offset=*/context.bufferOffset);
      gl.vertexAttribDivisor(aVertexPosition, 1);
      this.circleShader.draw(
          shader, context.renderContext,
          {interiorRadiusInPixels: 6, borderWidthInPixels: 2, featherWidthInPixels: 1},
          context.count);
      gl.vertexAttribDivisor(aVertexPosition, 0);
      gl.disableVertexAttribArray(aVertexPosition);
    });
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

export type MultiTool = typeof PlacePointTool|typeof PlaceBoundingBoxTool|typeof PlaceLineTool|
    typeof PlaceSphereTool|typeof PlaceLineStripTool|typeof MultiStepAnnotationTool;


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

registerTool(
    ANNOTATE_COLLECTION_TOOL_ID,
    (layer, options) => new MultiStepAnnotationTool(<UserLayerWithAnnotations>layer, options));
