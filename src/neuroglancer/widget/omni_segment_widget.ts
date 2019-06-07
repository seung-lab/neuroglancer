// import {verifyPositiveInt, verifyOptionalString, verifyOptionalNonnegativeInt} from
// 'neuroglancer/util/json';
import {SegmentMetadata} from 'neuroglancer/segment_metadata';
import {SegmentationDisplayState} from 'neuroglancer/segmentation_display_state/frontend';
import {RefCounted} from 'neuroglancer/util/disposable';
import {Uint64} from 'neuroglancer/util/uint64';

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
  categoryListContainer = document.createElement('div');
  private segmentIDToTableRowMap = new Map<string, HTMLTableRowElement>();
  private segmentIDRemapping = new Map<string, string>();
  private mergedSegmentVoxelCount = new Map<string, number>();

  constructor(displayState: SegmentationDisplayState, segmentMetadata: SegmentMetadata) {
    super();
    const {element, segmentTableContainer, segmentIDToTableRowMap, categoryListContainer} =
        this;
    let {segmentIDRemapping, mergedSegmentVoxelCount} = this;
    this.element.className = 'omni-segment-widget-element';
    const filterDropdownLabel = document.createElement('label');
    filterDropdownLabel.textContent = 'Filter segment IDs by category: ';
    const filterDropdown = document.createElement('select');
    filterDropdown.id = 'omni-segment-widget-filter';
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
    const filterDropdownDiv = document.createElement('div');
    filterDropdownDiv.appendChild(filterDropdownLabel);
    let showSegmentTable = false;
    const hideSegmentTableButton = document.createElement('button');
    const hideSegmentTableButtonContainer = document.createElement('div');
    hideSegmentTableButtonContainer.id = 'toggle-segment-table-visibility';
    hideSegmentTableButton.textContent = 'Hide segment table';
    hideSegmentTableButton.addEventListener('click', () => {
      if (showSegmentTable) {
        hideSegmentTableButton.textContent = 'Hide segment table';
        segmentTableContainer.style.display = '';
        filterDropdownDiv.style.display = '';
      } else {
        hideSegmentTableButton.textContent = 'Show segment table';
        segmentTableContainer.style.display = 'none';
        filterDropdownDiv.style.display = 'none';
      }
      showSegmentTable = !showSegmentTable;
    });
    hideSegmentTableButtonContainer.appendChild(hideSegmentTableButton);
    element.appendChild(hideSegmentTableButtonContainer);
    element.appendChild(filterDropdownDiv);
    // segmentTableContainer.appendChild(filterDropdownLabel);
    const segmentTable = document.createElement('table');
    segmentTable.className = 'omni-segment-table';
    const segmentTableHeader = document.createElement('tr');
    // const sortedStatusToButtonText = {
    //   'segUnsorted':
    // };
    const segmentIDColumnHeader = document.createElement('th');
    const sortBySegmentIDButton = document.createElement('button');
    const sortByVoxelCountButton = document.createElement('button');
    sortBySegmentIDButton.textContent = 'Segment ID';
    let sortedBySegmentID = false;
    let sortedBySegAscending = false;
    let sortedByVoxelCount = false;
    let sortedByVCAscending = false;
    sortBySegmentIDButton.addEventListener('click', () => {
      const segmentTableRows = Array.from(segmentIDToTableRowMap.values());
      while (segmentTable.rows.length > 1) {
        segmentTable.deleteRow(1);
      }
      if (sortedBySegmentID && sortedBySegAscending) {
        segmentTableRows.sort((a, b) => {
          const aU64 = Uint64.parseString(a.children[0].textContent!, 10);
          const bU64 = Uint64.parseString(b.children[0].textContent!, 10);
          return Uint64.compare(bU64, aU64);
        });
        sortedBySegmentID = true;
        sortedBySegAscending = false;
        sortedByVoxelCount = false;
        sortedByVCAscending = false;
        sortBySegmentIDButton.textContent = 'Segment ID ▼';
        sortByVoxelCountButton.textContent = 'Voxel Count';
      } else {
        segmentTableRows.sort((a, b) => {
          const aU64 = Uint64.parseString(a.children[0].textContent!, 10);
          const bU64 = Uint64.parseString(b.children[0].textContent!, 10);
          return Uint64.compare(aU64, bU64);
        });
        sortedBySegmentID = true;
        sortedBySegAscending = true;
        sortedByVoxelCount = false;
        sortedByVCAscending = false;
        sortBySegmentIDButton.textContent = 'Segment ID ▲';
        sortByVoxelCountButton.textContent = 'Voxel Count';
      }
      segmentTableRows.forEach(row => {
        segmentTable.appendChild(row);
      });
    });
    segmentIDColumnHeader.appendChild(sortBySegmentIDButton);
    // segmentIDColumnHeader.textContent = 'Segment ID';
    const voxelCountHeader = document.createElement('th');
    sortByVoxelCountButton.textContent = 'Voxel Count';
    sortByVoxelCountButton.addEventListener('click', () => {
      const segmentTableRows = Array.from(segmentIDToTableRowMap.values());
      while (segmentTable.rows.length > 1) {
        segmentTable.deleteRow(1);
      }
      if (sortedByVoxelCount && sortedByVCAscending) {
        segmentTableRows.sort((a, b) => {
          return parseInt(b.children[1].textContent!, 10) -
              parseInt(a.children[1].textContent!, 10);
        });
        sortedByVoxelCount = true;
        sortedByVCAscending = false;
        sortedBySegmentID = false;
        sortedBySegAscending = false;
        sortBySegmentIDButton.textContent = 'Segment ID';
        sortByVoxelCountButton.textContent = 'Voxel Count ▼';
      } else {
        segmentTableRows.sort((a, b) => {
          return parseInt(a.children[1].textContent!, 10) -
              parseInt(b.children[1].textContent!, 10);
        });
        sortedByVoxelCount = true;
        sortedByVCAscending = true;
        sortedBySegmentID = false;
        sortedBySegAscending = false;
        sortBySegmentIDButton.textContent = 'Segment ID';
        sortByVoxelCountButton.textContent = 'Voxel Count ▲';
      }
      segmentTableRows.forEach(row => {
        segmentTable.appendChild(row);
      });
    });
    voxelCountHeader.appendChild(sortByVoxelCountButton);
    // voxelCountHeader.textContent = 'Voxel Count';
    const categoryHeader = document.createElement('th');
    categoryHeader.textContent = 'Category';
    segmentTableHeader.appendChild(segmentIDColumnHeader);
    segmentTableHeader.appendChild(voxelCountHeader);
    segmentTableHeader.appendChild(categoryHeader);
    segmentTable.appendChild(segmentTableHeader);
    filterDropdown.addEventListener('change', () => {
      for (const [segmentID, row] of segmentIDToTableRowMap) {
        if ((!segmentIDRemapping.has(segmentID)) &&
            (filterDropdown.selectedOptions[0].value === '0' ||
             (<HTMLSelectElement>(row.cells[2].firstChild!)).selectedIndex ===
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
      // segmentIDElement.textContent = segmentIDString;
      const addSegmentToRootSegments = document.createElement('button');
      addSegmentToRootSegments.textContent = segmentIDString;
      addSegmentToRootSegments.style.backgroundColor =
          displayState.segmentColorHash.computeCssColor(segmentID);
      addSegmentToRootSegments.addEventListener('click', () => {
        if (displayState.rootSegments.has(segmentID)) {
          displayState.rootSegments.delete(segmentID);
        } else {
          displayState.rootSegments.add(segmentID);
        }
      });
      segmentIDElement.appendChild(addSegmentToRootSegments);
      const voxelCountElement = document.createElement('td');
      voxelCountElement.textContent = voxelCount.toString();
      const categoryDropdownCell = document.createElement('td');
      const categoryDropdown = document.createElement('select');
      categoryDropdown.className = 'omni-segment-widget-category-dropdown';
      const defaultOption = document.createElement('option');
      defaultOption.textContent = '';
      defaultOption.value = '0';
      categoryDropdown.appendChild(defaultOption);
      let currentOptionIndex = 1;
      for (const [categoryId, categoryName] of segmentMetadata.segmentCategories) {
        const option = document.createElement('option');
        option.textContent = categoryName;
        option.value = String(categoryId);
        categoryDropdown.appendChild(option);
        if (categoryIDForSegment === categoryId) {
          statusIndex = currentOptionIndex;
        }
        currentOptionIndex++;
      }
      categoryDropdown.selectedIndex = statusIndex;
      categoryDropdown.addEventListener('change', () => {
        const categoryId = Number(filterDropdown.options[categoryDropdown.selectedIndex].value);
        segmentMetadata.categorizedSegments.set(segmentIDString, categoryId);
        // specificationChanged.dispatch();
        segmentMetadata.changed.dispatch();
      });
      categoryDropdownCell.appendChild(categoryDropdown);
      segmentRow.appendChild(segmentIDElement);
      segmentRow.appendChild(voxelCountElement);
      segmentRow.appendChild(categoryDropdownCell);
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
    const segmentEquivalenceTable = document.createElement('table');
    const segmentEquivalenceTableHeader = document.createElement('tr');
    const segmentEquivanceIDHeader = document.createElement('th');
    segmentEquivanceIDHeader.textContent = 'ID';
    const segmentEquivalenceEquivalentSegmentsHeader = document.createElement('th');
    segmentEquivalenceEquivalentSegmentsHeader.textContent = 'Equivalent IDs';
    // const toggleEquivalenceHeader = document.createElement('th');
    // toggleEquivalenceHeader.textContent = 'Toggle';
    segmentEquivalenceTableHeader.appendChild(segmentEquivanceIDHeader);
    segmentEquivalenceTableHeader.appendChild(segmentEquivalenceEquivalentSegmentsHeader);
    // segmentEquivalenceTableHeader.appendChild(toggleEquivalenceHeader);
    segmentEquivalenceTable.appendChild(segmentEquivalenceTableHeader);
    // let segmentEquivalenceChangedFromTable = false;
    const makeSegmentEquivalenceTable = () => {
      // if (!segmentEquivalenceChangedFromTable) {
      const segmentEquivalenceMap = new Map<string, string[]>();
      for (const [segmentID, maxSegmentID] of segmentIDRemapping) {
        const listOfEquivalentSegments = segmentEquivalenceMap.get(maxSegmentID);
        if (listOfEquivalentSegments === undefined) {
          segmentEquivalenceMap.set(maxSegmentID, [segmentID]);
        } else {
          listOfEquivalentSegments.push(segmentID);
        }
      }
      while (segmentEquivalenceTable.rows.length > 1) {
        segmentEquivalenceTable.deleteRow(1);
      }
      for (const [segmentID, listOfEquivalentSegments] of segmentEquivalenceMap) {
        const currentRow = document.createElement('tr');
        const segmentIDCell = document.createElement('td');
        // segmentIDCell.textContent = segmentID;
        const segmentIDCellButton = document.createElement('button');
        segmentIDCellButton.textContent = segmentID;
        segmentIDCellButton.title = `Show/hide segment ID ${segmentID}`;
        segmentIDCellButton.addEventListener('click', () => {
          const segmentIDU64 = Uint64.parseString(segmentID, 10);
          if (displayState.rootSegments.has(segmentIDU64)) {
            displayState.rootSegments.delete(segmentIDU64);
          } else {
            displayState.rootSegments.add(segmentIDU64);
          }
        });
        segmentIDCell.appendChild(segmentIDCellButton);
        currentRow.appendChild(segmentIDCell);
        const segmentListCell = document.createElement('td');
        // segmentListCell.textContent = listOfEquivalentSegments.join();
        const removeEquivalenceButton = document.createElement('button');
        removeEquivalenceButton.textContent = 'x';
        removeEquivalenceButton.title = 'Delete this equivalence';
        removeEquivalenceButton.addEventListener('click', () => {
          const confirmed = confirm('Are you sure you want to delete this equivalence?');
          if (confirmed) {
            displayState.segmentEquivalences.deleteSet(Uint64.parseString(segmentID, 10));
          }
        });
        segmentListCell.appendChild(removeEquivalenceButton);
        listOfEquivalentSegments.forEach(equivalentSegment => {
          const currentButton = document.createElement('button');
          currentButton.textContent = equivalentSegment;
          segmentListCell.appendChild(currentButton);
        });
        currentRow.appendChild(segmentIDCell);
        currentRow.appendChild(segmentListCell);
        // const toggleEquivalenceCheckbox = document.createElement('input');
        // toggleEquivalenceCheckbox.type = 'checkbox';
        // toggleEquivalenceCheckbox.checked = true;
        // const toggleEquivalenceButton = document.createElement('button');
        // let equivalenceIsOn = true;
        // toggleEquivalenceButton.textContent = 'x';
        // toggleEquivalenceButton.style.backgroundImage
        // toggleEquivalenceCheckbox.addEventListener('change', () => {
        // segmentEquivalenceChangedFromTable = true;
        // if (toggleEquivalenceCheckbox.checked) {
        // }
        // displayState.segmentEquivalences.deleteSet(Uint64.parseString(segmentID, 10));
        // segmentEquivalenceTable.removeChild(currentRow);
        // segmentEquivalenceChangedFromTable = false;
        // });
        // currentRow.appendChild(toggleEquivalenceCheckbox);
        segmentEquivalenceTable.appendChild(currentRow);
      }
      // }
    };
    makeSegmentEquivalenceTable();
    let showSegmentEquivalenceTable = false;
    const hideSegmentEquivalenceTableButton = document.createElement('button');
    hideSegmentEquivalenceTableButton.id = 'toggle-segment-equivalence-visibility';
    hideSegmentEquivalenceTableButton.textContent = 'Hide segment equivalence table';
    hideSegmentEquivalenceTableButton.addEventListener('click', () => {
      if (showSegmentEquivalenceTable) {
        hideSegmentEquivalenceTableButton.textContent =
            'Hide segment equivalence table';
        segmentEquivalenceTable.style.display = '';
        // filterDropdownDiv.style.display = 'flex';
      } else {
        hideSegmentEquivalenceTableButton.textContent =
            'Show segment equivalence table';
        segmentEquivalenceTable.style.display = 'none';
        // filterDropdownDiv.style.display = 'none';
      }
      showSegmentEquivalenceTable = !showSegmentEquivalenceTable;
    });
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
      makeSegmentEquivalenceTable();
    });
    categoryListContainer.id = 'omni-segment-category-table-container';
    const segmentCategoryList = document.createElement('ul');
    segmentCategoryList.id = 'omni-segment-category-table';
    // const segmentCategoryTableHeader = document.createElement('tr');
    // const categoryIDColumnHeader = document.createElement('th');
    // categoryIDColumnHeader.textContent = 'ID';
    // const categoryNameHeader = document.createElement('th');
    // categoryNameHeader.textContent = 'Categories';
    // segmentCategoryTableHeader.appendChild(categoryIDColumnHeader);
    // segmentCategoryTableHeader.appendChild(categoryNameHeader);
    // segmentCategoryList.appendChild(segmentCategoryTableHeader);
    for (const categoryName of segmentMetadata.segmentCategories.values()) {
      // const segmentCategoryRow = document.createElement('tr');
      // const categoryIdCell = document.createElement('td');
      // categoryIdCell.textContent = String(categoryId);
      // const categoryNameCell = document.createElement('td');
      // categoryNameCell.textContent = categoryName;
      // segmentCategoryRow.appendChild(categoryIdCell);
      const categoryItem = document.createElement('li');
      categoryItem.textContent = categoryName;
      // segmentCategoryRow.appendChild(categoryNameCell);
      segmentCategoryList.appendChild(categoryItem);
    }
    const categoryInput = document.createElement('input');
    categoryInput.id = 'segment-category-input';
    // const categoryNameInputLabel = document.createElement('label');
    // categoryNameInputLabel.textContent = 'Enter your category name';
    // categoryNameInput.appendChild(categoryNameInputLabel);
    categoryInput.placeholder = 'Enter your category';
    categoryInput.title = 'Enter the category you wish to add';
    const categoryNameInputButton = document.createElement('button');
    categoryNameInputButton.id = 'segment-category-input-button';
    categoryNameInputButton.textContent = 'Add category';
    categoryNameInputButton.addEventListener('click', () => {
      if (categoryInput.value === '') {
        alert('Category name cannot be empty');
      } else {
        const categoryId = segmentMetadata.addNewCategory(categoryInput.value);
        const segmentCategoryRow = document.createElement('tr');
        const categoryIdCell = document.createElement('td');
        categoryIdCell.textContent = String(categoryId);
        const categoryNameCell = document.createElement('td');
        categoryNameCell.textContent = categoryInput.value;
        segmentCategoryRow.appendChild(categoryIdCell);
        segmentCategoryRow.appendChild(categoryNameCell);
        segmentCategoryList.appendChild(segmentCategoryRow);
        categoryInput.value = '';
      }
    });
    let showCategoryList = false;
    const hideCategoryListButtonContainer = document.createElement('div');
    hideCategoryListButtonContainer.id = 'toggle-segment-category-visibility';
    const hideCategoryListButton = document.createElement('button');
    hideCategoryListButton.textContent = 'Hide category list';
    hideCategoryListButton.addEventListener('click', () => {
      if (showCategoryList) {
        hideCategoryListButton.textContent = 'Hide category list';
        categoryListContainer.style.display = 'flex';
        addCategoryDiv.style.display = 'flex';
      } else {
        hideCategoryListButton.textContent = 'Show category list';
        categoryListContainer.style.display = 'none';
        addCategoryDiv.style.display = 'none';
      }
      showCategoryList = !showCategoryList;
    });
    const addCategoryDiv = document.createElement('div');
    addCategoryDiv.id = 'add-segment-category-div';
    addCategoryDiv.appendChild(categoryInput);
    addCategoryDiv.appendChild(categoryNameInputButton);
    // segmentCategoryTableContainer.appendChild(categoryNameInput);
    // segmentCategoryTableContainer.appendChild(categoryNameInputButton);
    categoryListContainer.appendChild(segmentCategoryList);
    hideCategoryListButtonContainer.appendChild(hideCategoryListButton);
    element.appendChild(hideCategoryListButtonContainer);
    element.appendChild(addCategoryDiv);
    element.appendChild(categoryListContainer);
    element.appendChild(hideSegmentEquivalenceTableButton);
    element.appendChild(segmentEquivalenceTable);
    // const segmentEquivalenceTable = document.createElement('ta');

    // displayState.segmentEquivalences.toJSON
  }
}
