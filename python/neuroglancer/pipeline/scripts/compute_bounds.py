import sys
import os

from tqdm import tqdm

from neuroglancer.lib import Bbox, max2
from neuroglancer.pipeline import Storage
from neuroglancer.pipeline.volumes import CloudVolume

layer_path = sys.argv[1]

cv = CloudVolume(layer_path)

print cv.key

bboxes = []

with Storage(layer_path) as stor:
  for filename in tqdm(stor.list_files(prefix=cv.key), desc="Computing Bounds"):
    bboxes.append( Bbox.from_filename(filename) )

bounds = Bbox.expand(*bboxes)
chunk_size = reduce(max2, map(lambda bbox: bbox.size3(), bboxes))
print('bounds={} (size: {}); chunk_size={}'.format(bounds, bounds.size3(), chunk_size))







