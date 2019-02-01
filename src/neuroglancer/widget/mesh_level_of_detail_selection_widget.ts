import './voxel_size_selection_widget.css';

import {TrackableValue} from 'neuroglancer/trackable_value';
import {RefCounted} from 'neuroglancer/util/disposable';
import {removeFromParent} from 'neuroglancer/util/dom';

export class MeshLevelOfDetailSelectionWidget extends RefCounted {
  element = document.createElement('div');

  constructor(selectedLevelOfDetail: TrackableValue<number>, maxLevelOfDetail: number) {
    super();
    const {element} = this;
    const header = document.createElement('div');
    header.textContent = 'Select mesh level of detail:';
    header.id = 'meshLevelOfDetailSelectionHeader';
    const meshLevelOfDetailDropdown = document.createElement('select');
    meshLevelOfDetailDropdown.className = 'voxel-selection-dropdown';
    for (let i = 0; i < maxLevelOfDetail; ++i) {
      const iString = i.toString();
      if (i === selectedLevelOfDetail.value) {
        meshLevelOfDetailDropdown.add(new Option(iString, iString, false, true));
      } else {
        meshLevelOfDetailDropdown.add(new Option(iString, iString, false, false));
      }
    }
    meshLevelOfDetailDropdown.addEventListener('change', () => {
      if (selectedLevelOfDetail.value !== meshLevelOfDetailDropdown.selectedIndex) {
        selectedLevelOfDetail.value = meshLevelOfDetailDropdown.selectedIndex;
      }
    });
    this.registerDisposer(selectedLevelOfDetail.changed.add(() => {
      if (selectedLevelOfDetail.value !== meshLevelOfDetailDropdown.selectedIndex) {
        meshLevelOfDetailDropdown.selectedIndex = selectedLevelOfDetail.value;
      }
    }));
    element.appendChild(header);
    element.appendChild(meshLevelOfDetailDropdown);
  }

  disposed() {
    removeFromParent(this.element);
    super.disposed();
  }
}
