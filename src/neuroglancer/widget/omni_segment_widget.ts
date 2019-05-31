import {SegmentationDisplayState} from 'neuroglancer/segmentation_display_state/frontend';
import {RefCounted} from 'neuroglancer/util/disposable';
import {Uint64} from 'neuroglancer/util/uint64';
import {NullarySignal} from 'neuroglancer/util/signal';
// import {verifyPositiveInt, verifyOptionalString, verifyOptionalNonnegativeInt} from 'neuroglancer/util/json';
import {SegmentMetadata} from 'neuroglancer/segment_metadata';
// import {getObjectKey} from 'neuroglancer/segmentation_display_state/base';

require('./omni_segment_widget.css');
// const temp = new Uint64();
// const SEGMENT_ID_JSON_KEY = 'segmentId';
// const VOXEL_COUNT_JSON_KEY = 'voxelCount';
// const STATUS_CODE_JSON_KEY = 'status';
// const DESCRIPTION_JSON_KEY = 'description';

export class OmniSegmentWidget extends RefCounted {
  element = document.createElement('div');
  segmentTableContainer = document.createElement('div');
  segmentEquivalenceTableContainer = document.createElement('div');
  private segmentIDToTableRowMap = new Map<string, HTMLTableRowElement>();
  private segmentIDRemapping = new Map<string, string>();
  private mergedSegmentVoxelCount = new Map<string, number>();

  // constructor(displayState: SegmentationDisplayState, segmentMetadataObj: any[], specificationChanged: NullarySignal) {
  //   super();
  //   const {
  //     element,
  //     segmentTableContainer,
  //     segmentIDToTableRowMap,
  //   } = this;
  //   let {segmentIDRemapping, mergedSegmentVoxelCount} = this;
  //   this.element.className = 'omni-segment-widget-element';
  //   const statusOptions = ['Working', 'Valid', 'Uncertain'];
  //   const filterDropdownLabel = document.createElement('label');
  //   filterDropdownLabel.textContent = 'Filter segment IDs by status: ';
  //   const filterDropdown = document.createElement('select');
  //   const viewAllOption = document.createElement('option');
  //   viewAllOption.textContent = 'View all';
  //   filterDropdown.appendChild(viewAllOption);
  //   statusOptions.forEach(statusOption => {
  //     const option = document.createElement('option');
  //     option.textContent = statusOption;
  //     filterDropdown.appendChild(option);
  //   });
  //   filterDropdownLabel.appendChild(filterDropdown);
  //   this.element.appendChild(filterDropdownLabel);
  //   const segmentTable = document.createElement('table');
  //   segmentTable.className = 'omni-segment-table';
  //   const segmentTableHeader = document.createElement('tr');
  //   const segmentIDColumnHeader = document.createElement('th');
  //   segmentIDColumnHeader.textContent = 'Segment ID';
  //   const voxelCountHeader = document.createElement('th');
  //   voxelCountHeader.textContent = 'Voxel Count';
  //   const statusHeader = document.createElement('th');
  //   statusHeader.textContent = 'Status';
  //   const descriptionHeader = document.createElement('th');
  //   descriptionHeader.textContent = 'Description';
  //   segmentTableHeader.appendChild(segmentIDColumnHeader);
  //   segmentTableHeader.appendChild(voxelCountHeader);
  //   segmentTableHeader.appendChild(statusHeader);
  //   segmentTable.appendChild(segmentTableHeader);
  //   filterDropdown.addEventListener('change', () => {
  //     for (const [segmentID, row] of segmentIDToTableRowMap) {
  //       if ((!segmentIDRemapping.has(segmentID)) &&
  //           (filterDropdown.selectedOptions[0].textContent === 'View all' || (<HTMLSelectElement>(row.cells[2].firstChild!)).selectedOptions[0].textContent ===
  //            filterDropdown.selectedOptions[0].textContent)) {
  //         row.style.display = 'table-row';
  //       } else {
  //         row.style.display = 'none';
  //       }
  //     }
  //   });
  //   const stringToVoxelCountMap = new Map<string, number>();
  //   for (const segmentObj of segmentMetadataObj) {
  //     const segmentIDString = String(segmentObj[SEGMENT_ID_JSON_KEY]);
  //     const segmentID = Uint64.parseString(segmentIDString, 10);
  //     const voxelCount = verifyPositiveInt(segmentObj[VOXEL_COUNT_JSON_KEY]);
  //     const description = verifyOptionalString(segmentObj[DESCRIPTION_JSON_KEY]);
  //     const statusIndex = verifyOptionalNonnegativeInt(segmentObj[STATUS_CODE_JSON_KEY]);
  //     const segmentRow = document.createElement('tr');
  //     const segmentIDElement = document.createElement('td');
  //     stringToVoxelCountMap.set(segmentIDString, voxelCount);
  //     segmentIDElement.textContent = segmentIDString;
  //     const voxelCountElement = document.createElement('td');
  //     voxelCountElement.textContent = voxelCount.toString();
  //     const statusDropdownCell = document.createElement('td');
  //     const statusDropdown = document.createElement('select');
  //     statusOptions.forEach(statusOption => {
  //       const option = document.createElement('option');
  //       option.textContent = statusOption;
  //       statusDropdown.appendChild(option);
  //     });
  //     statusDropdown.selectedIndex = statusIndex || 0;
  //     statusDropdown.addEventListener('change', () => {
  //       segmentObj[STATUS_CODE_JSON_KEY] = statusDropdown.selectedIndex;
  //       specificationChanged.dispatch();
  //     });
  //     statusDropdownCell.appendChild(statusDropdown);
  //     const descriptionCell = document.createElement('td');
  //     const descriptionTextarea = document.createElement('textarea');
  //     descriptionTextarea.textContent = description || '';
  //     descriptionTextarea.addEventListener('change', () => {
  //       segmentObj[DESCRIPTION_JSON_KEY] = descriptionTextarea.textContent;
  //       specificationChanged.dispatch();
  //     });
  //     descriptionCell.appendChild(descriptionTextarea);
  //     segmentRow.appendChild(segmentIDElement);
  //     segmentRow.appendChild(voxelCountElement);
  //     segmentRow.appendChild(statusDropdownCell);
  //     segmentRow.appendChild(descriptionCell);
  //     if (displayState.segmentEquivalences.has(segmentID)) {
  //       const maxSegmentID = displayState.segmentEquivalences.get(segmentID);
  //       const maxSegmentIDString = maxSegmentID.toString();
  //       const currentVoxelCount = mergedSegmentVoxelCount.get(maxSegmentIDString);
  //       if (currentVoxelCount === undefined) {
  //         mergedSegmentVoxelCount.set(maxSegmentIDString, voxelCount);
  //       } else {
  //         mergedSegmentVoxelCount.set(maxSegmentIDString, currentVoxelCount + voxelCount);
  //       }
  //       if (!Uint64.equal(segmentID, maxSegmentID)) {
  //         segmentIDRemapping.set(segmentIDString, maxSegmentIDString);
  //         segmentRow.style.display = 'none';
  //       }
  //     }
  //     segmentIDToTableRowMap.set(segmentIDString, segmentRow);
  //     segmentTable.appendChild(segmentRow);
  //   }
  //   for (const [segmentIDString, voxelCount] of mergedSegmentVoxelCount) {
  //     const associatedRow = segmentIDToTableRowMap.get(segmentIDString)!;
  //     associatedRow.cells[1].textContent = voxelCount.toString();
  //   }
  //   segmentTableContainer.className = 'omni-segment-table-container';
  //   segmentTableContainer.appendChild(segmentTable);
  //   element.appendChild(segmentTableContainer);
  //   displayState.segmentEquivalences.changed.add(() => {
  //     const newSegmentIDRemapping = new Map<string, string>();
  //     const newMergedSegmentVoxelCount = new Map<string, number>();
  //     for (const [segmentID, maxSegmentID] of displayState.segmentEquivalences.disjointSets) {
  //       const maxSegmentIDString = maxSegmentID.toString();
  //       const currentVoxelCount = newMergedSegmentVoxelCount.get(maxSegmentIDString);
  //       const segmentIDString = segmentID.toString();
  //       const voxelCount = stringToVoxelCountMap.get(segmentIDString)!;
  //       if (currentVoxelCount === undefined) {
  //         newMergedSegmentVoxelCount.set(maxSegmentIDString, voxelCount);
  //       } else {
  //         newMergedSegmentVoxelCount.set(maxSegmentIDString, currentVoxelCount + voxelCount);
  //       }
  //       const segmentRow = segmentIDToTableRowMap.get(segmentIDString)!;
  //       if (!Uint64.equal(segmentID, maxSegmentID)) {
  //         newSegmentIDRemapping.set(segmentIDString, maxSegmentIDString);
  //         segmentRow.style.display = 'none';
  //       } else {
  //         segmentRow.style.display = 'table-row';
  //       }
  //     }
  //     for (const [segmentIDString, voxelCount] of newMergedSegmentVoxelCount) {
  //       const associatedRow = segmentIDToTableRowMap.get(segmentIDString)!;
  //       associatedRow.cells[1].textContent = voxelCount.toString();
  //     }
  //     for (const segmentIDString of segmentIDRemapping.keys()) {
  //       if (!newSegmentIDRemapping.has(segmentIDString)) {
  //         const segmentRow = segmentIDToTableRowMap.get(segmentIDString)!;
  //         segmentRow.style.display = 'table-row';
  //       }
  //     }
  //     segmentIDRemapping = newSegmentIDRemapping;
  //     mergedSegmentVoxelCount = newMergedSegmentVoxelCount;
  //   });
  // }

  constructor(displayState: SegmentationDisplayState, segmentMetadata: SegmentMetadata, specificationChanged: NullarySignal) {
    super();
    const {
      element,
      segmentTableContainer,
      segmentIDToTableRowMap,
    } = this;
    let {segmentIDRemapping, mergedSegmentVoxelCount} = this;
    this.element.className = 'omni-segment-widget-element';
    const filterDropdownLabel = document.createElement('label');
    filterDropdownLabel.textContent = 'Filter segment IDs by status: ';
    const filterDropdown = document.createElement('select');
    const viewAllOption = document.createElement('option');
    viewAllOption.textContent = 'View all';
    viewAllOption.value = '0';
    filterDropdown.appendChild(viewAllOption);
    for (const [categoryId, categoryName] of segmentMetadata.segmentCategories) {
      const option = document.createElement('option');
      option.textContent = categoryName;
      option.value = String(categoryId);
      filterDropdown.appendChild(option);
    }
    filterDropdownLabel.appendChild(filterDropdown);
    this.element.appendChild(filterDropdownLabel);
    const segmentTable = document.createElement('table');
    segmentTable.className = 'omni-segment-table';
    const segmentTableHeader = document.createElement('tr');
    const segmentIDColumnHeader = document.createElement('th');
    segmentIDColumnHeader.textContent = 'Segment ID';
    const voxelCountHeader = document.createElement('th');
    voxelCountHeader.textContent = 'Voxel Count';
    const categoryHeader = document.createElement('th');
    categoryHeader.textContent = 'Category';
    segmentTableHeader.appendChild(segmentIDColumnHeader);
    segmentTableHeader.appendChild(voxelCountHeader);
    segmentTableHeader.appendChild(categoryHeader);
    segmentTable.appendChild(segmentTableHeader);
    filterDropdown.addEventListener('change', () => {
      for (const [segmentID, row] of segmentIDToTableRowMap) {
        if ((!segmentIDRemapping.has(segmentID)) &&
            (filterDropdown.selectedOptions[0].value === '0' || (<HTMLSelectElement>(row.cells[2].firstChild!)).selectedIndex ===
             filterDropdown.selectedIndex)) {
          row.style.display = 'table-row';
        } else {
          row.style.display = 'none';
        }
      }
    });
    const stringToVoxelCountMap = new Map<string, number>();
    for (const [segmentIDString, voxelCount] of segmentMetadata.segmentToVoxelCountMap) {
      const segmentID = Uint64.parseString(segmentIDString, 10);
      let statusIndex = 0;
      const categoryIDForSegment = segmentMetadata.categorizedSegments.get(segmentIDString);
      const segmentRow = document.createElement('tr');
      const segmentIDElement = document.createElement('td');
      stringToVoxelCountMap.set(segmentIDString, voxelCount);
      segmentIDElement.textContent = segmentIDString;
      const voxelCountElement = document.createElement('td');
      voxelCountElement.textContent = voxelCount.toString();
      const statusDropdownCell = document.createElement('td');
      const statusDropdown = document.createElement('select');
      const defaultOption = document.createElement('option');
      defaultOption.textContent = '';
      defaultOption.value = '0';
      statusDropdown.appendChild(defaultOption);
      let currentOptionIndex = 1;
      for (const [categoryId, categoryName] of segmentMetadata.segmentCategories) {
        const option = document.createElement('option');
        option.textContent = categoryName;
        option.value = String(categoryId);
        statusDropdown.appendChild(option);
        if (categoryIDForSegment === categoryId) {
          statusIndex = currentOptionIndex;
        }
        currentOptionIndex++;
      }
      statusDropdown.selectedIndex = statusIndex;
      statusDropdown.addEventListener('change', () => {
        const categoryId = Number(filterDropdown.options[statusDropdown.selectedIndex].value);
        segmentMetadata.categorizedSegments.set(segmentIDString, categoryId);
        specificationChanged.dispatch();
      });
      statusDropdownCell.appendChild(statusDropdown);
      // const descriptionCell = document.createElement('td');
      // const descriptionTextarea = document.createElement('textarea');
      // descriptionTextarea.textContent = description || '';
      // descriptionTextarea.addEventListener('change', () => {
      //   segmentObj[DESCRIPTION_JSON_KEY] = descriptionTextarea.textContent;
      //   specificationChanged.dispatch();
      // });
      // descriptionCell.appendChild(descriptionTextarea);
      segmentRow.appendChild(segmentIDElement);
      segmentRow.appendChild(voxelCountElement);
      segmentRow.appendChild(statusDropdownCell);
      // segmentRow.appendChild(descriptionCell);
      if (displayState.segmentEquivalences.has(segmentID)) {
        const maxSegmentID = displayState.segmentEquivalences.get(segmentID);
        const maxSegmentIDString = maxSegmentID.toString();
        const currentVoxelCount = mergedSegmentVoxelCount.get(maxSegmentIDString);
        if (currentVoxelCount === undefined) {
          mergedSegmentVoxelCount.set(maxSegmentIDString, voxelCount);
        } else {
          mergedSegmentVoxelCount.set(maxSegmentIDString, currentVoxelCount + voxelCount);
        }
        if (!Uint64.equal(segmentID, maxSegmentID)) {
          segmentIDRemapping.set(segmentIDString, maxSegmentIDString);
          segmentRow.style.display = 'none';
        }
      }
      segmentIDToTableRowMap.set(segmentIDString, segmentRow);
      segmentTable.appendChild(segmentRow);
    }
    for (const [segmentIDString, voxelCount] of mergedSegmentVoxelCount) {
      const associatedRow = segmentIDToTableRowMap.get(segmentIDString)!;
      associatedRow.cells[1].textContent = voxelCount.toString();
    }
    segmentTableContainer.className = 'omni-segment-table-container';
    segmentTableContainer.appendChild(segmentTable);
    element.appendChild(segmentTableContainer);
    displayState.segmentEquivalences.changed.add(() => {
      const newSegmentIDRemapping = new Map<string, string>();
      const newMergedSegmentVoxelCount = new Map<string, number>();
      for (const [segmentID, maxSegmentID] of displayState.segmentEquivalences.disjointSets) {
        const maxSegmentIDString = maxSegmentID.toString();
        const currentVoxelCount = newMergedSegmentVoxelCount.get(maxSegmentIDString);
        const segmentIDString = segmentID.toString();
        const voxelCount = stringToVoxelCountMap.get(segmentIDString)!;
        if (currentVoxelCount === undefined) {
          newMergedSegmentVoxelCount.set(maxSegmentIDString, voxelCount);
        } else {
          newMergedSegmentVoxelCount.set(maxSegmentIDString, currentVoxelCount + voxelCount);
        }
        const segmentRow = segmentIDToTableRowMap.get(segmentIDString)!;
        if (!Uint64.equal(segmentID, maxSegmentID)) {
          newSegmentIDRemapping.set(segmentIDString, maxSegmentIDString);
          segmentRow.style.display = 'none';
        } else {
          segmentRow.style.display = 'table-row';
        }
      }
      for (const [segmentIDString, voxelCount] of newMergedSegmentVoxelCount) {
        const associatedRow = segmentIDToTableRowMap.get(segmentIDString)!;
        associatedRow.cells[1].textContent = voxelCount.toString();
      }
      for (const segmentIDString of segmentIDRemapping.keys()) {
        if (!newSegmentIDRemapping.has(segmentIDString)) {
          const segmentRow = segmentIDToTableRowMap.get(segmentIDString)!;
          segmentRow.style.display = 'table-row';
        }
      }
      segmentIDRemapping = newSegmentIDRemapping;
      mergedSegmentVoxelCount = newMergedSegmentVoxelCount;
    });
  }
}
