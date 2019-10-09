import {Annotation, AnnotationReference, AnnotationType, AxisAlignedBoundingBox, Collection, Line} from 'neuroglancer/annotation';
import {AnnotationLayerState} from 'neuroglancer/annotation/frontend';
import {MouseSelectionState} from 'neuroglancer/layer';
import {StatusMessage} from 'neuroglancer/status';
import {UserLayerWithAnnotations} from 'neuroglancer/ui/annotations';
import {Tool} from 'neuroglancer/ui/tool';
import {vec3} from 'neuroglancer/util/geom';
import {verifyObjectProperty, verifyOptionalString} from 'neuroglancer/util/json';
import {Uint64} from 'neuroglancer/util/uint64';
import {MultiStepAnnotationTool} from './collection';

export function getMousePositionInAnnotationCoordinates(
    mouseState: MouseSelectionState, annotationLayer: AnnotationLayerState) {
  return vec3.transformMat4(vec3.create(), mouseState.position, annotationLayer.globalToObject);
}

export function getSelectedAssocatedSegment(annotationLayer: AnnotationLayerState) {
  let segments: Uint64[]|undefined;
  const segmentationState = annotationLayer.segmentationState.value;
  if (segmentationState != null) {
    if (segmentationState.segmentSelectionState.hasSelectedSegment) {
      segments = [segmentationState.segmentSelectionState.selectedSegment.clone()];
    }
  }
  return segments;
}

export abstract class PlaceAnnotationTool extends Tool {
  temp?: Annotation;
  group: string;
  annotationDescription: string|undefined;
  annotationType: AnnotationType.POINT|AnnotationType.LINE|
      AnnotationType.AXIS_ALIGNED_BOUNDING_BOX|AnnotationType.ELLIPSOID|
      AnnotationType.COLLECTION|AnnotationType.LINE_STRIP|AnnotationType.SPOKE;
  parentTool?: MultiStepAnnotationTool;
  constructor(public layer: UserLayerWithAnnotations, options: any) {
    super();
    if (layer.annotationLayerState === undefined) {
      throw new Error(`Invalid layer for annotation tool.`);
    }
    this.parentTool = options ? options.parent : void (0);
    this.annotationDescription = verifyObjectProperty(options, 'description', verifyOptionalString);
  }

  get annotationLayer() {
    return this.layer.annotationLayerState.value;
  }

  complete() {
    StatusMessage.showTemporaryMessage(`Only supported in collection annotations.`, 3000);
  }
}

export abstract class TwoStepAnnotationTool extends PlaceAnnotationTool {
  inProgressAnnotation:
      {annotationLayer: AnnotationLayerState, reference: AnnotationReference, disposer: () => void}|
      undefined;

  abstract getInitialAnnotation(
      mouseState: MouseSelectionState, annotationLayer: AnnotationLayerState): Annotation;
  abstract getUpdatedAnnotation(
      oldAnnotation: Annotation, mouseState: MouseSelectionState,
      annotationLayer: AnnotationLayerState): Annotation;

  isOrphanTool(): boolean {
    const parent = this.parentTool;
    if (parent && parent.inProgressAnnotation) {
      return parent.childTool !== this;
    }
    // Can't be orphan if never had a parent
    return false;
  }

  trigger(
      mouseState: MouseSelectionState, parentRef?: AnnotationReference,
      spoofMouse?: MouseSelectionState) {
    const {annotationLayer} = this;
    if (annotationLayer === undefined) {
      // Not yet ready.
      return;
    }
    if (mouseState.active) {
      const updatePointB = () => {
        if (!this.isOrphanTool()) {
          const state = this.inProgressAnnotation!;
          const reference = state.reference;
          const newAnnotation =
              this.getUpdatedAnnotation(reference.value!, mouseState, annotationLayer);
          state.annotationLayer.source.update(reference, newAnnotation);
          this.layer.selectedAnnotation.value = {id: reference.id};
        } else {
          this.inProgressAnnotation!.disposer();
        }
      };

      if (this.inProgressAnnotation === undefined || !this.inProgressAnnotation.reference.value) {
        const annotation = this.getInitialAnnotation(spoofMouse || mouseState, annotationLayer);
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

export abstract class PlaceTwoCornerAnnotationTool extends TwoStepAnnotationTool {
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
