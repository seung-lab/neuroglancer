import {UserLayer} from 'neuroglancer/layer';
import {TrackableMIPLevelConstraints} from 'neuroglancer/trackable_mip_level_constraints';
import {UserLayerWithVolumeSource, UserLayerWithVolumeSourceMixin} from 'neuroglancer/user_layer_with_volume_source';
import {RenderLayer as GenericSliceViewRenderLayer} from 'neuroglancer/sliceview/renderlayer.ts';
import {vec3} from 'neuroglancer/util/geom';
import { Tab } from 'neuroglancer/widget/tab_view';
import { VoxelSizeSelectionWidget } from 'neuroglancer/widget/voxel_size_selection_widget';

const MIN_MIP_LEVEL_JSON_KEY = 'minMIPLevel';
const MAX_MIP_LEVEL_JSON_KEY = 'maxMIPLevel';

function helper<TBase extends {new (...args: any[]): UserLayerWithVolumeSource}>(Base: TBase) {
  class C extends Base implements UserLayerWithMIPLevelConstraints {
    mipLevelConstraints = new TrackableMIPLevelConstraints();
    private loadingOptionsTab: LoadingOptionsTab;
    private voxelSizePerMIPLevel: vec3[] = [];

    constructor(...args:any[]) {
      super(...args);
      this.tabs.add('loading', {label: 'Loading', order: 1000, getter: () => {
        this.loadingOptionsTab = new LoadingOptionsTab(this.mipLevelConstraints);
        if (this.voxelSizePerMIPLevel.length > 0) {
          // In this case render layer metadata retrieved before tab created
          this.loadingOptionsTab.populateVoxelChoices(this.voxelSizePerMIPLevel);
        }
        return this.loadingOptionsTab;
      }});
    }

    restoreState(specification: any) {
      super.restoreState(specification);
      this.mipLevelConstraints.restoreState(specification[MIN_MIP_LEVEL_JSON_KEY], specification[MAX_MIP_LEVEL_JSON_KEY]);
      this.registerDisposer(this.mipLevelConstraints.changed.add(this.specificationChanged.dispatch));
    }

    toJSON(): any {
      const result = super.toJSON();
      result[MIN_MIP_LEVEL_JSON_KEY] = this.mipLevelConstraints.minMIPLevel.value;
      result[MAX_MIP_LEVEL_JSON_KEY] = this.mipLevelConstraints.maxMIPLevel.value;
      return result;
    }

    protected populateVoxelSelectionWidget(renderlayer: GenericSliceViewRenderLayer) {
      renderlayer.transformedSources.forEach(transformedSource => {
        this.voxelSizePerMIPLevel.push(transformedSource[0].source.spec.voxelSize);
      });
      if (this.loadingOptionsTab) {
        // In this case render layer metadata retrieved after tab created
        this.loadingOptionsTab.populateVoxelChoices(this.voxelSizePerMIPLevel);
      }
    }
  }
  return C;
}
export interface UserLayerWithMIPLevelConstraints extends UserLayerWithVolumeSource {
  mipLevelConstraints: TrackableMIPLevelConstraints;
}

/**
 * Mixin that adds `minMIPLevelRendered` and `maxMIPLevelRendered` properties to a user layer
 * (along with the properties added by calling UserLayerWithVolumeSourceMixin)
 */
export function
UserLayerWithMIPLevelConstraintsMixin<TBase extends {new (...args: any[]): UserLayer}>(
    Base: TBase) {
  return helper(UserLayerWithVolumeSourceMixin(Base));
}

class LoadingOptionsTab extends Tab {
  voxelSizeSelectionWidget = this.registerDisposer(new VoxelSizeSelectionWidget(
    this.mipLevelConstraints));

  constructor(private mipLevelConstraints: TrackableMIPLevelConstraints) {
    super();
    this.element.appendChild(this.voxelSizeSelectionWidget.element);
  }

  public populateVoxelChoices(voxelSizePerMIPLevel: vec3[]) {
    this.voxelSizeSelectionWidget.populateVoxelChoices(voxelSizePerMIPLevel);
  }
}
