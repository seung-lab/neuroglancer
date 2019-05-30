// import {Uint64} from 'neuroglancer/util/uint64';

// export interface SegmentMetadataBase {
//     segmentID: Uint64;
//     voxelCount: number;
// }

// export interface SegmentMetadata extends SegmentMetadataBase {
//     categoryID?: number;
// }

export type SegmentCategory = Map<string, string>;

export type SegmentMetadata = Map<string, {voxelCount: number, categoryID?: number}>;
