import { Tab } from "../widget/tab_view";
import { AnnotationLayerState } from "./frontend";

export class AnnotationTab extends Tab {
    private stack = this.registerDisposer(
        new StackView<AnnotationLayerState, AnnotationLayerView>(annotationLayerState => {
          return new AnnotationLayerView(
              this.layer, this.state.addRef(), annotationLayerState.addRef(), this.voxelSize.addRef(),
              this.setSpatialCoordinates);
        }, this.visibility));
    private detailsTab = this.registerDisposer(
        new AnnotationDetailsTab(this.state, this.voxelSize.addRef(), this.setSpatialCoordinates));
    constructor(
        public layer: Borrowed<UserLayerWithAnnotations>,
        public state: Owned<SelectedAnnotationState>, public voxelSize: Owned<VoxelSize>,
        public setSpatialCoordinates: (point: vec3) => void) {
      super();
      this.registerDisposer(state);
      this.registerDisposer(voxelSize);
      const {element} = this;
      element.classList.add('neuroglancer-annotations-tab');
      this.stack.element.classList.add('neuroglancer-annotations-stack');
      element.appendChild(this.stack.element);
      element.appendChild(this.detailsTab.element);
      const updateDetailsVisibility = () => {
        this.detailsTab.visibility.value = this.state.validValue !== undefined && this.visible ?
            WatchableVisibilityPriority.VISIBLE :
            WatchableVisibilityPriority.IGNORED;
      };
      this.registerDisposer(this.state.changed.add(updateDetailsVisibility));
      this.registerDisposer(this.visibility.changed.add(updateDetailsVisibility));
      const setAnnotationLayerView = () => {
        this.stack.selected = this.state.annotationLayerState.value;
      };
      this.registerDisposer(this.state.annotationLayerState.changed.add(setAnnotationLayerView));
      setAnnotationLayerView();
    }
  }
  