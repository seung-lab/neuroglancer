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

import {Annotation, AnnotationReference, AnnotationType, LineStrip} from 'neuroglancer/annotation';
import {MultiStepAnnotationTool} from 'neuroglancer/annotation/collection';
import {AnnotationLayerState} from 'neuroglancer/annotation/frontend';
import {PlaceLineTool} from 'neuroglancer/annotation/line';
import {AnnotationRenderContext, AnnotationRenderHelper, registerAnnotationTypeRenderHandler} from 'neuroglancer/annotation/type_handler';
import {MouseSelectionState} from 'neuroglancer/layer';
import {StatusMessage} from 'neuroglancer/status';
import {UserLayerWithAnnotations} from 'neuroglancer/ui/annotations';
import {registerTool} from 'neuroglancer/ui/tool';
import {mat4, vec3} from 'neuroglancer/util/geom';
import {CircleShader} from 'neuroglancer/webgl/circles';
import {emitterDependentShaderGetter, ShaderBuilder} from 'neuroglancer/webgl/shader';
// TODO: Collection annotations should not be rendered at all, if possible remove drawing code

const ANNOTATE_LINE_STRIP_TOOL_ID = 'annotateLineStrip';

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

registerAnnotationTypeRenderHandler(AnnotationType.LINE_STRIP, {
  bytes: 3 * 4,
  serializer: (buffer: ArrayBuffer, offset: number, numAnnotations: number) => {
    const coordinates = new Float32Array(buffer, offset, numAnnotations * 3);
    return (annotation: LineStrip, index: number) => {
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
    if (this.toolbox && this.toolbox.querySelector('.neuroglancer-linestrip-looped')) {
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

  complete(shortcut?: boolean) {
    if (this.inProgressAnnotation) {
      const innerEntries = (<LineStrip>this.inProgressAnnotation!.reference.value!).entries;
      if (shortcut) {
        const {lastA, lastB} = <any>this.inProgressAnnotation!.reference!.value!;
        this.safeDelete(lastA);
        this.safeDelete(lastB);
      }
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

registerTool(
    ANNOTATE_LINE_STRIP_TOOL_ID,
    (layer, options) => new PlaceLineStripTool(<UserLayerWithAnnotations>layer, options));
