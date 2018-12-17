import {TrackableMIPLevelConstraints} from 'neuroglancer/trackable_mip_level_constraints';
import {RefCounted} from 'neuroglancer/util/disposable';
import {removeFromParent} from 'neuroglancer/util/dom';
import {vec3} from 'neuroglancer/util/geom';
import './voxel_size_selection_widget.css';

export class VoxelSizeSelectionWidget extends RefCounted {
  element = document.createElement('div');
  minVoxelSizeElement = document.createElement('div');
  maxVoxelSizeElement = document.createElement('div');
  haveVoxelChoicesBeenPopulated = false;

  constructor(public mipLevelConstraints: TrackableMIPLevelConstraints) {
    super();
    const header = document.createElement('div');
    header.textContent = 'Voxel size limits (nm)';
    this.element.appendChild(header);
  }

  public populateVoxelChoices(voxelSizePerMIPLevel: vec3[]) {
    if (!this.haveVoxelChoicesBeenPopulated) {
      this.haveVoxelChoicesBeenPopulated = true;
      const {
        element,
        minVoxelSizeElement,
        maxVoxelSizeElement,
        createVoxelSizeDropdown,
        createVoxelDropdownOptions,
        mipLevelConstraints,
        mipLevelConstraints: {minMIPLevel, maxMIPLevel}
      } = this;
      element.className = 'minmax-voxel-size-selection';
      minVoxelSizeElement.className = 'voxel-size-selection';
      maxVoxelSizeElement.className = 'voxel-size-selection';
      const voxelDropdownOptions = createVoxelDropdownOptions(voxelSizePerMIPLevel);
      const minVoxelSizeDropdown = createVoxelSizeDropdown(voxelDropdownOptions, true);
      const maxVoxelSizeDropdown = createVoxelSizeDropdown(voxelDropdownOptions, false);
      const minVoxelSizeLabel = document.createElement('span');
      minVoxelSizeLabel.textContent = 'Min voxel size: ';
      minVoxelSizeLabel.id = 'minVoxelSizeLabel';
      const maxVoxelSizeLabel = document.createElement('span');
      maxVoxelSizeLabel.textContent = 'Max voxel size: ';
      minVoxelSizeElement.appendChild(minVoxelSizeLabel);
      minVoxelSizeElement.appendChild(minVoxelSizeDropdown);
      maxVoxelSizeElement.appendChild(maxVoxelSizeLabel);
      maxVoxelSizeElement.appendChild(maxVoxelSizeDropdown);
      element.appendChild(minVoxelSizeElement);
      element.appendChild(maxVoxelSizeElement);
      this.registerDisposer(minMIPLevel.changed.add(() => {
        VoxelSizeSelectionWidget.setDropdownIndex(
            minVoxelSizeDropdown, mipLevelConstraints.getDeFactoMinMIPLevel());
      }));
      this.registerDisposer(maxMIPLevel.changed.add(() => {
        VoxelSizeSelectionWidget.setDropdownIndex(
            maxVoxelSizeDropdown, mipLevelConstraints.getDeFactoMaxMIPLevel());
      }));
    }
    else {
      throw new Error('Attempt to load voxel sizes more than once');
    }
  }

  private createVoxelDropdownOptions(voxelSizePerMIPLevel: vec3[]) {
    const voxelDropdownOptions: string[] = [];
    voxelSizePerMIPLevel.forEach(voxelSize => {
      let i: number;
      let voxelString = '';
      for (i = 0; i < 3; i++) {
        if (i > 0) {
          voxelString += ' x ';
        }
        voxelString += voxelSize[i];
      }
      voxelDropdownOptions.push(voxelString);
    });
    return voxelDropdownOptions;
  }

  private createVoxelSizeDropdown = (voxelDropdownOptions: string[], isMinLevelDropdown: boolean):
      HTMLSelectElement => {
        const {mipLevelConstraints} = this;
        const getMIPValue = (isMinLevelDropdown) ? mipLevelConstraints.getDeFactoMinMIPLevel :
                                                   mipLevelConstraints.getDeFactoMaxMIPLevel;
        const mipLevel = (isMinLevelDropdown) ? mipLevelConstraints.minMIPLevel :
                                                mipLevelConstraints.maxMIPLevel;
        const voxelSizeDropdown = document.createElement('select');
        voxelSizeDropdown.className = 'voxel-selection-dropdown';
        voxelDropdownOptions.forEach((voxelSizeString, index) => {
          if (index === getMIPValue()) {
            voxelSizeDropdown.add(new Option(voxelSizeString, index.toString(), false, true));
          } else {
            voxelSizeDropdown.add(new Option(voxelSizeString, index.toString(), false, false));
          }
        });
        voxelSizeDropdown.addEventListener('change', () => {
          if (getMIPValue() !== voxelSizeDropdown.selectedIndex) {
            mipLevel.value = voxelSizeDropdown.selectedIndex;
          }
        });
        return voxelSizeDropdown;
      }

  private static setDropdownIndex(dropdown: HTMLSelectElement, newIndex: number) {
    if (dropdown.selectedIndex !== newIndex) {
      dropdown.selectedIndex = newIndex;
    }
  }

  disposed() {
    removeFromParent(this.element);
    super.disposed();
  }
}
