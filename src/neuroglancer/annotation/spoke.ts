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
 * @file Support for rendering line strip annotations.
 */

import {Annotation, AnnotationReference, AnnotationType, Spoke} from 'neuroglancer/annotation';
import {MultiStepAnnotationTool} from 'neuroglancer/annotation/collection';
import {AnnotationLayerState} from 'neuroglancer/annotation/frontend';
import {AnnotationRenderContext, AnnotationRenderHelper, registerAnnotationTypeRenderHandler} from 'neuroglancer/annotation/type_handler';
import {MouseSelectionState} from 'neuroglancer/layer';
import {UserLayerWithAnnotations} from 'neuroglancer/ui/annotations';
import {registerTool} from 'neuroglancer/ui/tool';
import {mat4, vec3} from 'neuroglancer/util/geom';
import {CircleShader} from 'neuroglancer/webgl/circles';
import {emitterDependentShaderGetter, ShaderBuilder} from 'neuroglancer/webgl/shader';
import {PlaceLineTool} from './line';
// TODO: Collection annotations should not be rendered at all, if possible remove drawing code

const ANNOTATE_SPOKE_TOOL_ID = 'annotateSpoke';

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

registerAnnotationTypeRenderHandler(AnnotationType.SPOKE, {
  bytes: 3 * 4,
  serializer: (buffer: ArrayBuffer, offset: number, numAnnotations: number) => {
    const coordinates = new Float32Array(buffer, offset, numAnnotations * 3);
    return (annotation: Spoke, index: number) => {
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

export class PlaceSpokeTool extends MultiStepAnnotationTool {
  annotationType: AnnotationType.SPOKE;
  toolset = PlaceLineTool;
  initMouseState: MouseSelectionState;
  initPos: any;
  wheeled = false;
  lastMouseState?: MouseSelectionState;
  lastPos?: any;
  constructor(public layer: UserLayerWithAnnotations, options: any) {
    super(layer, options);
    this.childTool = new this.toolset(layer, options);
    this.toolbox = options.toolbox;
    if (this.toolbox && this.toolbox.querySelector('.neuroglancer-spoke-wheeled')) {
      this.wheeled = true;
    }
  }

  getInitialAnnotation(mouseState: MouseSelectionState, annotationLayer: AnnotationLayerState):
      Annotation {
    const result = <Spoke>super.getInitialAnnotation(mouseState, annotationLayer);
    result.connected = true;
    result.wheeled = this.wheeled;
    result.type = this.annotationType;
    return result;
  }

  trigger(mouseState: MouseSelectionState, parentRef?: AnnotationReference) {
    if (mouseState.active) {
      if (this.inProgressAnnotation === undefined) {
        this.initMouseState = <MouseSelectionState>{...mouseState};
        this.initPos = mouseState.position.slice();
        super.trigger(mouseState, parentRef);
        this.lastMouseState = void(0);
        this.lastPos = void(0);
      } else {
        super.trigger(mouseState, parentRef);
        // Start new annotation automatically at source point
        const source = <MouseSelectionState>{...this.initMouseState, position: this.initPos};
        if (this.wheeled && this.lastMouseState && this.lastPos) {
          // Connect the current completed and last completed points
          const intermediate =
              <MouseSelectionState>{...this.lastMouseState, position: this.lastPos};
          this.appendNewChildAnnotation(this.inProgressAnnotation.reference!, intermediate);
          super.trigger(mouseState, parentRef);
        }
        this.appendNewChildAnnotation(this.inProgressAnnotation.reference!, mouseState, source);
        this.lastMouseState = <MouseSelectionState>{...mouseState};
        this.lastPos = mouseState.position.slice();
      }
    }
  }

  get description() {
    return `annotate spoke ${this.wheeled ? '(wheel)' : ''}`;
  }

  toJSON() {
    return ANNOTATE_SPOKE_TOOL_ID;
  }
}
PlaceSpokeTool.prototype.annotationType = AnnotationType.SPOKE;

registerTool(
    ANNOTATE_SPOKE_TOOL_ID,
    (layer, options) => new PlaceSpokeTool(<UserLayerWithAnnotations>layer, options));
