import {SegmentationDisplayState} from 'neuroglancer/segmentation_display_state/frontend';
import {RefCounted} from 'neuroglancer/util/disposable';
import {Uint64} from 'neuroglancer/util/uint64';

require('./omni_segment_widget.css');

export class OmniSegmentWidget extends RefCounted {
  element = document.createElement('div');
  segmentTableContainer = document.createElement('div');
  segmentEquivalenceTableContainer = document.createElement('div');
  // private segmentIDRemapping = new Map<Uint64, Uint64>();

  constructor(displayState: SegmentationDisplayState, segmentToVoxelMap: Map<Uint64, number>) {
    super();
    // const segmentListHeader = document.createElement('div');
    this.element.className = 'omni-segment-widget-element';
    const statusOptions = ['Working', 'Valid', 'Uncertain'];
    const filterDropdownLabel = document.createElement('label');
    filterDropdownLabel.textContent = 'Filter segment IDs by status: ';
    const filterDropdown = document.createElement('select');
    statusOptions.forEach(statusOption => {
      const option = document.createElement('option');
      option.textContent = statusOption;
      filterDropdown.appendChild(option);
    });
    filterDropdownLabel.appendChild(filterDropdown);
    this.element.appendChild(filterDropdownLabel);
    const segmentTable = document.createElement('table');
    segmentTable.className = 'omni-segment-table';
    const segmentTableHeader = document.createElement('tr');
    const segmentIDColumnHeader = document.createElement('th');
    segmentIDColumnHeader.textContent = 'Segment ID';
    const voxelCountHeader = document.createElement('th');
    voxelCountHeader.textContent = 'Voxel Count';
    const statusHeader = document.createElement('th');
    statusHeader.textContent = 'Status';
    segmentTableHeader.appendChild(segmentIDColumnHeader);
    segmentTableHeader.appendChild(voxelCountHeader);
    segmentTableHeader.appendChild(statusHeader);
    segmentTable.appendChild(segmentTableHeader);
    filterDropdown.addEventListener('change', () => {
      let tableHeader = true;
      for (const row of segmentTable.rows) {
        if (tableHeader) {
          tableHeader = false;
          continue;
        }
        if ((<HTMLSelectElement>(row.cells[2].firstChild!)).selectedOptions[0].textContent ===
            filterDropdown.selectedOptions[0].textContent) {
          row.style.display = 'table-row';
        } else {
          row.style.display = 'none';
        }
      }
    });
    for (const [segmentID, voxelCount] of segmentToVoxelMap) {
      const segmentRow = document.createElement('tr');
      const segmentIDElement = document.createElement('td');
      segmentIDElement.textContent = segmentID.toString();
      const voxelCountElement = document.createElement('td');
      voxelCountElement.textContent = voxelCount.toString();
      const statusDropdownCell = document.createElement('td');
      const statusDropdown = document.createElement('select');
      statusOptions.forEach(statusOption => {
        const option = document.createElement('option');
        option.textContent = statusOption;
        statusDropdown.appendChild(option);
      });
      statusDropdownCell.appendChild(statusDropdown);
      segmentRow.appendChild(segmentIDElement);
      segmentRow.appendChild(voxelCountElement);
      segmentRow.appendChild(statusDropdownCell);
      segmentTable.appendChild(segmentRow);
    }
    this.segmentTableContainer.className = 'omni-segment-table-container';
    this.segmentTableContainer.appendChild(segmentTable);
    this.element.appendChild(this.segmentTableContainer);
    // this.element.appendChild(segmentTable);
    console.log(displayState);
  }
}