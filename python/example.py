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
viewer = neuroglancer.Viewer()

def on_state_changed(state):
  try:
    visible_segments =  map(int, state['layers']['segmentation']['segments'])
  except KeyError:
    visible_segments = []
  print (visible_segments)
  return None
viewer.on_state_changed = on_state_changed

with h5py.File('./snemi3d/image.h5') as f:
  img = np.pad(f['main'][:], 1, 'constant', constant_values=0)
  viewer.add(volume_type='image', data=img, name='image', voxel_size=[6, 6, 40])

# if you add this layer by itself neuroglancer doesn't know the dataset size
# viewer.add(volume_type='point', name='point_annotation')

# if you add this layer by itself neuroglancer doesn't know the dataset size
viewer.add(volume_type='synapse', name='synapse')


with h5py.File('./snemi3d/machine_labels.h5') as f:
  # 0 pad is useful to make the meshes that are in contact with the borders
  # of the volume have a planar cap
  seg = np.pad(f['main'][:], 1, 'constant', constant_values=0)
  viewer.add(volume_type='segmentation', data=seg, name='segmentation', voxel_size=[6, 6, 40], graph='./snemi3d/snemi3d_graph.pickle')

webbrowser.open(viewer.get_viewer_url())
print(viewer.get_viewer_url())
