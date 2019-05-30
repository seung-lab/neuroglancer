import neuroglancer
# import cloudvolume
import numpy as np
from cloudvolume import CloudVolume
from cloudvolume.lib import Bbox
import json

cv_path = 'gs://neuroglancer/kisuk/CREMI/dodam/B/ground_truth/draft02'
mip = 0
cv = CloudVolume(cv_path, mip)
max_allowed_size = np.int64(3000000000)
if np.prod(cv.volume_size) > max_allowed_size:
    raise ValueError('Volume exceeds maximum of 3 billion voxels')
volume_bbox = Bbox(cv.voxel_offset, cv.shape[0:3] + cv.voxel_offset)
data = cv[volume_bbox]
unique_segids = np.unique(data, return_counts=True)
del data
arr = np.array([])
for x in zip(unique_segids[0], unique_segids[1]):
    if x[0] != 0:
        arr = np.append(arr, {
            "segmentId": str(x[0]),
            "voxelCount": x[1]
        })
# import ipdb
# ipdb.set_trace()
# print(np.array2string(arr))
with open('test_json2.txt', 'w') as out_file:
    out_file.write(np.array2string(arr, separator=',', threshold=1000000))