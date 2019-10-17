/**
 * @file Support for rendering line strip annotations.
 */

import {Annotation, AnnotationReference, AnnotationType, Spoke} from 'neuroglancer/annotation';
import {MultiStepAnnotationTool} from 'neuroglancer/annotation/annotation';
import {AnnotationLayerState} from 'neuroglancer/annotation/frontend';
import {PlaceLineTool} from 'neuroglancer/annotation/line';
import {AnnotationRenderContext, AnnotationRenderHelper, registerAnnotationTypeRenderHandler} from 'neuroglancer/annotation/type_handler';
import {MouseSelectionState} from 'neuroglancer/layer';
import {UserLayerWithAnnotations} from 'neuroglancer/ui/annotations';
import {registerTool} from 'neuroglancer/ui/tool';
import {mat4, vec3} from 'neuroglancer/util/geom';

const ANNOTATE_SPOKE_TOOL_ID = 'annotateSpoke';

class RenderHelper extends AnnotationRenderHelper {
  draw(context: AnnotationRenderContext) {
    context;
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
    this.childTool = new this.toolset(layer, {...options, parent: this});
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
      if (this.inProgressAnnotation === undefined || !this.inProgressAnnotation.reference.value) {
        this.initMouseState = <MouseSelectionState>{...mouseState};
        this.initPos = mouseState.position.slice();
        super.trigger(mouseState, parentRef);
        this.lastMouseState = void (0);
        this.lastPos = void (0);
        this.assignToParent(this.inProgressAnnotation!.reference, parentRef);
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
