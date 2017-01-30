from __future__ import print_function

import numpy as np
import h5py
import webbrowser

import neuroglancer

# Obtain the bundled Neuroglancer client code (HTML, CSS, and JavaScript) from
# the demo server, so that this example works even if
#
#   python setup.py bundle_client
#
# has not been run.
neuroglancer.set_static_content_source(url='http://localhost:8080')

def add_point_annotation(viewer, name='annotation'):
  empty_data = np.zeros(shape=[1,1,1],dtype=np.float32)
  viewer.add(empty_data, name=name, volume_type='pointAnnotation')

def add_synapse_annotation(viewer, name='annotation'):
  empty_data = np.zeros(shape=[1,1,1],dtype=np.float32)
  viewer.add(empty_data, name=name, volume_type='synapseAnnotation')

viewer = neuroglancer.Viewer(voxel_size=[6, 6, 40])
with h5py.File('./snemi3d/image.h5') as f:
  viewer.add(f['main'][:], name='image')

# add_point_annotation(viewer)
# add_synapse_annotation(viewer)

with h5py.File('./snemi3d/machine_labels.h5') as f:
  viewer.add(f['main'][:], name='segmentation')

webbrowser.open(viewer.get_viewer_url())
print(viewer.get_viewer_url())
