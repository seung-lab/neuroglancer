from __future__ import print_function

import neuroglancer
import numpy as np
import h5py

# Obtain the bundled Neuroglancer client code (HTML, CSS, and JavaScript) from
# the demo server, so that this example works even if
#
#   python setup.py bundle_client
#
# has not been run.
neuroglancer.set_static_content_source(url='https://neuroglancer-demo.appspot.com')

viewer = neuroglancer.Viewer(voxel_size=[6, 6, 40])
with h5py.File('./snemi3d/image.h5') as f:
  viewer.add(f['main'][:], name='image')

with h5py.File('./snemi3d/machine_labels.h5') as f:
  viewer.add(f['main'][:], name='segmentation')
print(viewer)
input()
