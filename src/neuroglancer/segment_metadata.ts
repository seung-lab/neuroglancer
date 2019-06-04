import {RefCounted} from 'neuroglancer/util/disposable';
import {verifyObjectProperty, verifyArray, verifyObject, verifyPositiveInt, verifyString} from 'neuroglancer/util/json';
import {Uint64} from 'neuroglancer/util/uint64';
import {NullarySignal} from 'neuroglancer/util/signal';

export type SegmentToVoxelCountMap = Map<string, number>;

// export type SegmentCategories = Map<number, string>;

// export type CategorizedSegments = Map<string, number>;

export class SegmentMetadata extends RefCounted {
  changed = new NullarySignal();

  private constructor(
      public segmentToVoxelCountMap: SegmentToVoxelCountMap,
      public segmentCategories: Map<number, string>,
      public categorizedSegments: Map<string, number>,
      private maxCategoryId: number) {
    super();
  }

  /** SegmentMetadata factory
   */
  static restoreState(segmentToVoxelCountMap: SegmentToVoxelCountMap, segmentCategoriesObj: any, categorizedSegmentsObj: any) {
    const segmentCategories = new Map<number, string>();
    const categorizedSegments = new Map<string, number>();
    let maxCategoryId = 0;
    if (segmentCategoriesObj) {
      verifyArray(segmentCategoriesObj);
      segmentCategoriesObj.forEach((category: any) => {
        verifyObject(category);
        const categoryId = verifyObjectProperty(category, 'id', verifyPositiveInt);
        if (categoryId > maxCategoryId) {
          maxCategoryId = categoryId;
        }
        const categoryName = verifyObjectProperty(category, 'name', verifyString);
        if (segmentCategories.has(categoryId)) {
          throw new Error('Duplicate segment category id in JSON state');
        }
        segmentCategories.set(categoryId, categoryName);
      });
    }
    if (categorizedSegmentsObj) {
      verifyArray(categorizedSegmentsObj);
      categorizedSegmentsObj.forEach((segment: any) => {
        verifyObject(segment);
        if (!segment['id']) {
          throw new Error(
              `Required key 'id' for categorized segment obj ${categorizedSegmentsObj} is missing`);
        }
        const segmentIdString = String(segment['id']);
        const categoryId = verifyObjectProperty(segment, 'categoryId', verifyPositiveInt);
        if (!segmentCategories.has(categoryId)) {
          throw new Error(`Segment id ${segmentIdString} mapped to unknown category id ${
              categoryId} in JSON state`);
        }
        categorizedSegments.set(segmentIdString, categoryId);
      });
    }
    return new SegmentMetadata(segmentToVoxelCountMap, segmentCategories, categorizedSegments, maxCategoryId);
  }

  addNewCategory(name: string) {
    this.maxCategoryId++;
    this.segmentCategories.set(this.maxCategoryId, name);
    this.changed.dispatch();
    return this.maxCategoryId;
  }

  segmentCategoriesToJSON() {
    const result = [];
    for (const [categoryId, categoryName] of this.segmentCategories) {
      result.push({
        'id': categoryId,
        'name': categoryName
      });
    }
    return result;
  }

  categorizedSegmentsToJSON() {
    const result = [];
    for (const [segmentId, categoryId] of this.categorizedSegments) {
      result.push({
        'id': Uint64.parseString(segmentId, 10),
        'categoryId': categoryId
      });
    }
    return result;
  }
}
