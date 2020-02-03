import {Annotation, AnnotationReference, AnnotationSource, AnnotationType, AxisAlignedBoundingBox, Collection, Ellipsoid, getAnnotationTypeHandler, Line, LineStrip, LocalAnnotationSource, Point, Spoke} from 'neuroglancer/annotation';
import {AnnotationLayerState} from 'neuroglancer/annotation/frontend';
import {VoxelSize} from 'neuroglancer/navigation_state';
import {TrackableBoolean} from 'neuroglancer/trackable_boolean';
import {WatchableValue} from 'neuroglancer/trackable_value';
import {AnnotationSegmentListWidget, getPositionSummary, SelectedAnnotationState} from 'neuroglancer/ui/annotations';
import {Owned} from 'neuroglancer/util/disposable';
import {removeChildren} from 'neuroglancer/util/dom';
import {transformVectorByMat4, vec3} from 'neuroglancer/util/geom';
import {formatBoundingBoxVolume, formatIntegerBounds, formatLength} from 'neuroglancer/util/spatial_units';
import {Uint64} from 'neuroglancer/util/uint64';
import {makeCloseButton} from 'neuroglancer/widget/close_button';
import {Tab} from 'neuroglancer/widget/tab_view';
import {makeTextIconButton} from 'neuroglancer/widget/text_icon_button';

const tempVec3 = vec3.create();
export class AnnotationDetailsTab extends Tab {
  private valid = false;
  private mouseEntered = false;
  private hoverState: WatchableValue<{id: string, partIndex?: number}|undefined>|undefined;
  private segmentListWidget: AnnotationSegmentListWidget|undefined;
  constructor(
      public state: Owned<SelectedAnnotationState>, public voxelSize: VoxelSize,
      public setSpatialCoordinates: (point: vec3) => void) {
    super();
    this.element.classList.add('neuroglancer-annotation-details');
    this.registerDisposer(state);
    this.registerDisposer(voxelSize);
    this.registerDisposer(this.state.changed.add(() => {
      this.valid = false;
      this.updateView();
    }));
    this.registerDisposer(this.visibility.changed.add(() => this.updateView()));
    this.state.changed.add(() => {
      this.valid = false;
      this.updateView();
    });
    this.element.addEventListener('mouseenter', () => {
      this.mouseEntered = true;
      if (this.hoverState !== undefined) {
        this.hoverState.value = this.state.value;
      }
    });
    this.element.addEventListener('mouseleave', () => {
      this.mouseEntered = false;
      if (this.hoverState !== undefined) {
        this.hoverState.value = undefined;
      }
    });
    this.updateView();
  }

  private getAnnotationStateInfo() {
    const value = this.state.value!;
    const info = <any>{};
    const annotationLayer = this.state.annotationLayerState.value;
    if (annotationLayer) {
      info.isInProgress = annotationLayer.source.isPending(value.id);
      const annotation = annotationLayer.source.getReference(value.id).value!;
      const parent = annotation.parentId ?
          <Collection>annotationLayer.source.getReference(annotation.parentId).value :
          undefined;
      if (parent) {
        info.isLineSegment = parent.type === AnnotationType.LINE_STRIP;
        info.isSpoke = parent.type === AnnotationType.SPOKE;
        info.isChild = true;
        info.isSingleton = (parent.entries.length === 1);
      }
      if (!info.isLineSegment && !info.isInProgress) {
        info.groupSize = value.multiple ? value.multiple.size : 0;
      }
    }

    return info;
  }

  private createAnnotationDetailsTitleElement(annotation: Annotation, info: any) {
    const {isLineSegment, isInProgress} = info;
    const handler = getAnnotationTypeHandler(annotation.type);
    const title = document.createElement('div');
    title.className = 'neuroglancer-annotation-details-title';

    const icon = document.createElement('div');
    icon.className = 'neuroglancer-annotation-details-icon';
    icon.textContent = handler.icon;

    const titleText = document.createElement('div');
    titleText.className = 'neuroglancer-annotation-details-title-text';
    titleText.textContent = `${handler.description} ${isLineSegment ? '(segment)' : ''} ${
        isInProgress ? '(in progress)' : ''}`;
    // FIXME: Currently Spokes are mutable collections, since order doesn't matter even though
    // they are connected
    if (info.groupSize) {
      titleText.textContent = `${info.groupSize} annotations selected`;
      icon.textContent = '~';
    }
    title.appendChild(icon);
    title.appendChild(titleText);

    return title;
  }

  private editModeButton(annotation: Annotation) {
    const button = makeTextIconButton('📝');
    if (this.state.value && this.state.value.edit) {
      button.title = 'End edit mode';
    } else {
      button.title = 'Add to this collection';
    }
    button.addEventListener('click', () => {
      const editingKey = 'neuroglancer-annotation-editing';
      // FIXME: This bypasses the normal way styles are set
      if (this.state.value) {
        if (this.state.value.edit) {
          const target = document.querySelector(`[data-id="${this.state.value.edit}"]`);
          if (target) {
            target.classList.remove(editingKey);
          }
          delete this.state.value.edit;
        } else {
          this.state.value.edit = annotation.id;
          const target = document.querySelector(`[data-id="${annotation.id}"]`);
          if (target) {
            target.classList.add(editingKey);
          }
        }
        this.valid = false;
        this.updateView();
      }
    });
    return button;
  }

  private insertButton(annotation: Annotation) {
    const annotationLayer = this.state.annotationLayerState.value!;
    const button = makeTextIconButton('➕');
    button.addEventListener('click', () => {
      if (this.state.value && this.state.value.edit) {
        const {multiple, edit} = this.state.value;
        const parentReference = annotationLayer.source.getReference(edit);
        // TODO: get rid of set history
        const children = multiple ? [...multiple] : [annotation.id];
        if (parentReference.value) {
          (<AnnotationSource>annotationLayer.source).childReassignment(children, parentReference);
        }
      }
    });
    return button;
  }

  private evictButton(annotation: Annotation, isSingleton?: boolean) {
    const annotationLayer = this.state.annotationLayerState.value!;
    const button = makeTextIconButton('✂️', 'Extract from collection');
    button.addEventListener('click', () => {
      const parentReference = annotationLayer.source.getReference(annotation.parentId!);
      if (isSingleton) {
        try {
          annotationLayer.source.delete(parentReference);
        } finally {
          parentReference.dispose();
        }
      } else {
        (<AnnotationSource>annotationLayer.source).childReassignment([annotation.id]);
      }
      this.state.value = undefined;
    });
    return button;
  }

  private getSourcePoint(id: string) {
    const annotationLayer = this.state.annotationLayerState.value!;
    const annotation = annotationLayer.source.getReference(id).value!;
    switch (annotation.type) {
      case AnnotationType.AXIS_ALIGNED_BOUNDING_BOX:
      case AnnotationType.LINE:
        return (<Line|AxisAlignedBoundingBox>annotation).pointA;
      case AnnotationType.POINT:
        return (<Point>annotation).point;
      case AnnotationType.ELLIPSOID:
        return (<Ellipsoid>annotation).center;
      case AnnotationType.LINE_STRIP:
      case AnnotationType.SPOKE:
      case AnnotationType.COLLECTION:
        return (<LineStrip>annotation).source;
    }
  }

  private generateEmptyCollection(sourcePoint: vec3) {
    const annotationLayer = this.state.annotationLayerState.value!;
    const collection = <Collection>{
      id: '',
      type: AnnotationType.COLLECTION,
      description: '',
      entries: [],  // identical to target
      segments: [],
      connected: false,
      source: sourcePoint,
      entry: () => {},
      segmentSet: () => {},
      childrenVisible: new TrackableBoolean(true, true)
    };
    collection.entry = (index: number) =>
        (<LocalAnnotationSource>annotationLayer.source).get(collection.entries[index]);
    collection.segmentSet = () => {
      collection.segments = [];
      collection.entries.forEach((ref, index) => {
        ref;
        const child = <Annotation>collection.entry(index);
        if (collection.segments && child.segments) {
          collection.segments = [...collection.segments!, ...child.segments];
        }
      });
      if (collection.segments) {
        collection.segments = [...new Set(collection.segments.map((e) => e.toString()))].map(
            (s) => Uint64.parseString(s));
      }
    };
    return collection;
  }

  private groupButton() {
    const annotationLayer = this.state.annotationLayerState.value!;
    const value = this.state.value!;
    const button = makeTextIconButton('⚄', 'Create collection');
    button.addEventListener('click', () => {
      // Create a new collection with annotations in value.multiple
      let target: string[];
      if (value.multiple) {
        target = [...value.multiple];
      } else {
        target = [value.id];
      }
      const first = annotationLayer.source.getReference(target[0]).value!;
      let sourcePoint = this.getSourcePoint(first.id);
      const collection = this.generateEmptyCollection(sourcePoint);

      const collectionReference = (<AnnotationSource>annotationLayer.source).add(collection, true);
      if (first.parentId) {
        const firstParent = (<AnnotationSource>annotationLayer.source).getReference(first.parentId);
        (<AnnotationSource>annotationLayer.source)
            .childReassignment([collectionReference.value!.id], firstParent);
      }
      const emptyCollection =
          (<AnnotationSource>annotationLayer.source).childReassignment(target, collectionReference);

      // It shouldn't be possible for a collection to be empty twice, that is the child says the
      // parent is empty and then a subsequent child says the same
      emptyCollection.forEach((annotationReference: AnnotationReference) => {
        try {
          // Delete annotation and all its children
          annotationLayer.source.delete(annotationReference);
        } finally {
          annotationReference.dispose();
        }
      });
      this.state.value = {id: collectionReference.id};
    });
    return button;
  }

  generateLine(pointA: vec3, pointB: vec3) {
    const annotationLayer = this.state.annotationLayerState.value!;
    const line =
        <Line>{id: '', type: AnnotationType.LINE, description: '', pointA, pointB, segments: []};
    return (<AnnotationSource>annotationLayer.source).add(line, true);
  }

  private generateSpokeButton() {
    const annotationLayer = this.state.annotationLayerState.value!;
    const button = makeTextIconButton('⚹', 'Create Spoke using selected annotations as positions');
    const value = this.state.value!;
    button.addEventListener('click', () => {
      // Create a new spoke with annotation positions in value.multiple
      let target: string[];
      if (value.multiple) {
        target = [...value.multiple];
      } else {
        target = [value.id];
      }
      const first = annotationLayer.source.getReference(target[0]).value!;
      let sourcePoint = this.getSourcePoint(first.id);
      const collection = <Spoke>this.generateEmptyCollection(sourcePoint);
      collection.type = AnnotationType.SPOKE;
      collection.connected = true;

      const collectionReference = (<AnnotationSource>annotationLayer.source).add(collection, true);
      if (first.parentId) {
        const firstParent = (<AnnotationSource>annotationLayer.source).getReference(first.parentId);
        (<AnnotationSource>annotationLayer.source)
            .childReassignment([collectionReference.value!.id], firstParent);
      }
      // this is where it differs from group button
      // generate a spoke from given targets
      const lines: string[] = [];
      target.forEach((annotationId, index) => {
        if (!index) {
          return;
        }
        const pointB = this.getSourcePoint(annotationId);
        const line = this.generateLine(sourcePoint, pointB);
        lines.push(line.id);
      });
      (<AnnotationSource>annotationLayer.source).childReassignment(lines, collectionReference);

      this.state.value = {id: collectionReference.id};
    });
    return button;
  }

  private generateLineStripButton() {
    const annotationLayer = this.state.annotationLayerState.value!;
    const button =
        makeTextIconButton('ʌ', 'Create LineStrip using selected annotations as positions');
    const value = this.state.value!;
    button.addEventListener('click', () => {
      // Create a new spoke with annotation positions in value.multiple
      let target: string[];
      if (value.multiple) {
        target = [...value.multiple];
      } else {
        target = [value.id];
      }
      const first = annotationLayer.source.getReference(target[0]).value!;
      let sourcePoint = this.getSourcePoint(first.id);
      const collection = <LineStrip>this.generateEmptyCollection(sourcePoint);
      collection.type = AnnotationType.LINE_STRIP;
      collection.connected = true;

      const collectionReference = (<AnnotationSource>annotationLayer.source).add(collection, true);
      if (first.parentId) {
        const firstParent = (<AnnotationSource>annotationLayer.source).getReference(first.parentId);
        (<AnnotationSource>annotationLayer.source)
            .childReassignment([collectionReference.value!.id], firstParent);
      }
      // this is where it differs from group button
      // generate a spoke from given targets
      const lines: string[] = [];
      target.forEach((annotationId, index, targArr) => {
        if (!index) {
          return;
        }
        const previousId = targArr[index - 1];
        const pointA = this.getSourcePoint(previousId);
        const pointB = this.getSourcePoint(annotationId);
        const line = this.generateLine(pointA, pointB);
        lines.push(line.id);
      });
      (<AnnotationSource>annotationLayer.source).childReassignment(lines, collectionReference);

      this.state.value = {id: collectionReference.id};
    });
    return button;
  }

  private ungroupButton() {
    const annotationLayer = this.state.annotationLayerState.value!;
    const value = this.state.value!;
    const button = makeTextIconButton('💥', 'Extract all annotations');
    button.addEventListener('click', () => {
      const reference = annotationLayer.source.getReference(value.id);
      try {
        annotationLayer.source.delete(reference);
      } finally {
        reference.dispose();
      }
    });
    return button;
  }

  private deleteButton() {
    const annotationLayer = this.state.annotationLayerState.value!;
    const value = this.state.value!;
    const button = makeTextIconButton('🗑', 'Delete annotation');
    button.addEventListener('click', () => {
      let target: string[];
      if (value.multiple) {
        target = Array.from(value.multiple);
      } else {
        target = [value.id];
      }
      target.forEach((id: string) => {
        const reference = annotationLayer.source.getReference(id);
        try {
          // Delete annotation and all its children
          annotationLayer.source.delete(reference, true);
        } finally {
          reference.dispose();
        }
      });
    });
    return button;
  }

  private closeButton() {
    const button = makeCloseButton();
    button.title = 'Hide annotation details';
    button.addEventListener('click', () => {
      this.state.value = undefined;
    });
    return button;
  }

  private annotationDetailsAABB() {
    const {voxelSize} = this;
    const annotationLayer = this.state.annotationLayerState.value!;
    const {objectToGlobal} = annotationLayer;
    const annotation = <AxisAlignedBoundingBox>this.state.reference!.value;
    const detailSet = <HTMLDivElement[]>[];
    const volume = document.createElement('div');
    volume.className = 'neuroglancer-annotation-details-volume';
    volume.textContent =
        formatBoundingBoxVolume(annotation.pointA, annotation.pointB, objectToGlobal);
    detailSet.push(volume);

    // FIXME: only do this if it is axis aligned
    const spatialOffset = transformVectorByMat4(
        tempVec3, vec3.subtract(tempVec3, annotation.pointA, annotation.pointB), objectToGlobal);
    const voxelVolume = document.createElement('div');
    voxelVolume.className = 'neuroglancer-annotation-details-volume-in-voxels';
    const voxelOffset = voxelSize.voxelFromSpatial(tempVec3, spatialOffset);
    voxelVolume.textContent = `${formatIntegerBounds(voxelOffset)}`;
    detailSet.push(voxelVolume);

    return detailSet;
  }

  private annotationDetailsLine() {
    const {voxelSize} = this;
    const annotationLayer = this.state.annotationLayerState.value!;
    const {objectToGlobal} = annotationLayer;
    const annotation = <Line>this.state.reference!.value;
    const spatialOffset = transformVectorByMat4(
        tempVec3, vec3.subtract(tempVec3, annotation.pointA, annotation.pointB), objectToGlobal);
    const length = document.createElement('div');
    length.className = 'neuroglancer-annotation-details-length';
    const spatialLengthText = formatLength(vec3.length(spatialOffset));
    let voxelLengthText = '';
    if (voxelSize.valid) {
      const voxelLength = vec3.length(voxelSize.voxelFromSpatial(tempVec3, spatialOffset));
      voxelLengthText = `, ${Math.round(voxelLength)} vx`;
    }
    length.textContent = spatialLengthText + voxelLengthText;
    return length;
  }

  private annotationDetailsDescription() {
    const reference = <AnnotationReference>this.state.reference;
    const annotation = <Annotation>reference.value;
    const annotationLayer = <AnnotationLayerState>this.state.annotationLayerState.value;
    const description = document.createElement('textarea');
    description.value = annotation.description || '';
    description.rows = 3;
    description.className = 'neuroglancer-annotation-details-description';
    description.placeholder = 'Description';
    if (annotationLayer.source.readonly) {
      description.readOnly = true;
    } else {
      description.addEventListener('change', () => {
        const x = description.value;
        annotationLayer.source.update(reference, {...annotation, description: x ? x : undefined});
        annotationLayer.source.commit(reference);
      });
    }
    return description;
  }

  private updateView() {
    if (!this.visible) {
      this.element.style.display = 'none';
      this.hoverState = undefined;
      return;
    }
    this.element.style.display = '';
    if (this.valid) {
      return;
    }
    const {element} = this;
    removeChildren(element);
    this.valid = true;
    const {reference} = this.state;
    if (reference === undefined) {
      return;
    }
    const value = this.state.value!;
    const annotation = reference.value;
    if (annotation == null) {
      return;
    }
    const annotationLayer = this.state.annotationLayerState.value!;
    this.hoverState = annotationLayer.hoverState;
    if (this.mouseEntered) {
      this.hoverState.value = value;
    }

    const {objectToGlobal} = annotationLayer;
    const {voxelSize} = this;

    const info = this.getAnnotationStateInfo();
    const title = this.createAnnotationDetailsTitleElement(annotation, info);
    const {isLineSegment, isChild, isSingleton, isInProgress} = info;

    if (isLineSegment || isInProgress) {
      // not allowed to multi select line segments
      value.multiple = undefined;
      value.ungroupable = true;
    }

    // FIXME: TODO: Hack
    const liveEdit = document.querySelector(`.neuroglancer-annotation-editing`);
    if (liveEdit && this.state && this.state.value) {
      this.state.value.edit = (<HTMLElement>liveEdit).dataset.id;
    }

    const contextualButtons = <HTMLDivElement[]>[];
    if (!annotationLayer.source.readonly) {
      const {COLLECTION, LINE_STRIP, SPOKE} = AnnotationType;
      const specialCollectionTypes = <(AnnotationType | undefined)[]>[LINE_STRIP, SPOKE];
      const editMode = this.state.value ? this.state.value.edit : null;
      const readOnly = isLineSegment || isInProgress;

      if (editMode) {
        if (editMode !== annotation.id && !readOnly) {
          contextualButtons.push(this.insertButton(annotation));
        }
        contextualButtons.push(this.editModeButton(annotation));
      } else if (!readOnly) {
        if (value.multiple) {
          contextualButtons.push(this.groupButton());
          contextualButtons.push(this.generateSpokeButton());
          contextualButtons.push(this.generateLineStripButton());
        } else {
          if (annotation.type === COLLECTION) {
            contextualButtons.push(this.editModeButton(annotation));
          }
          if (isChild) {
            contextualButtons.push(this.evictButton(annotation, isSingleton));
          }
          contextualButtons.push(this.groupButton());
          if (annotation.type === COLLECTION || specialCollectionTypes.includes(annotation.type)) {
            contextualButtons.push(this.ungroupButton());
          }
        }
        contextualButtons.push(this.deleteButton());
      }
    }
    contextualButtons.push(this.closeButton());
    title.append(...contextualButtons);
    element.appendChild(title);

    if (!value.multiple) {
      const position = document.createElement('div');
      position.className = 'neuroglancer-annotation-details-position';
      getPositionSummary(
          position, annotation, objectToGlobal, voxelSize, this.setSpatialCoordinates);
      element.appendChild(position);

      if (annotation.type === AnnotationType.AXIS_ALIGNED_BOUNDING_BOX) {
        element.append(...this.annotationDetailsAABB());
      } else if (annotation.type === AnnotationType.LINE) {
        element.appendChild(this.annotationDetailsLine());
      }
    }

    let {segmentListWidget} = this;
    if (segmentListWidget !== undefined) {
      if (segmentListWidget.reference !== reference) {
        segmentListWidget.dispose();
        this.unregisterDisposer(segmentListWidget);
        segmentListWidget = this.segmentListWidget = undefined;
      }
    }
    if (segmentListWidget === undefined) {
      this.segmentListWidget = segmentListWidget =
          this.registerDisposer(new AnnotationSegmentListWidget(reference, annotationLayer));
    }
    element.appendChild(segmentListWidget.element);

    if (!value.multiple) {
      element.appendChild(this.annotationDetailsDescription());
    }
  }
}
