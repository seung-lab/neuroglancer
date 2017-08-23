import os
import sys
import webbrowser

import neuroglancer
import numpy as np
from neuroglancer.skeleton import Skeleton

# There are 3 options for accesing the frontend
# Option 1)
# neuroglancer.set_static_content_source(url='https://neuromancer-seung-import.appspot.com')

# Option 2)
# npm run build
neuroglancer.set_static_content_source(path=os.path.join(os.path.dirname(__file__), '../dist/dev')
)

# Option 3) Useful if you are developing the frontend
# run a local server `npm run dev-server`
# neuroglancer.set_static_content_source(url='http://localhost:8080')

viewer = neuroglancer.Viewer(voxel_size=[10, 10, 10])


#Fist layer (image)
a = np.zeros((3, 100, 100, 100), dtype=np.uint8)
ix, iy, iz = np.meshgrid(*[np.linspace(0, 1, n) for n in a.shape[1:]], indexing='ij')
a[0, :, :, :] = np.abs(np.sin(4 * (ix + iy))) * 255
a[1, :, :, :] = np.abs(np.sin(4 * (iy + iz))) * 255
a[2, :, :, :] = np.abs(np.sin(4 * (ix + iz))) * 255
viewer.add(a,
           name='a',
           # offset is in nm, not voxels
           offset=(200, 300, 150),
           shader="""
void main() {
  emitRGB(vec3(toNormalized(getDataValue(0)),
               toNormalized(getDataValue(1)),
               toNormalized(getDataValue(2))));
}
""")


#Second layer (segmentation)
b = np.cast[np.uint32](np.floor(np.sqrt((ix - 0.5)**2 + (iy - 0.5)**2 + (iz - 0.5)**2) * 10))
b = np.pad(b, 1, 'constant')
viewer.add(b, name='b')

#Third layer (points)
viewer.add(data=[], name='layer_point', layer_type='point')

#Fourth layer (synapses)
viewer.add(data=[], name='layer_synapse', layer_type='synapse')

#Fith layer (vector graphics)
viewer.add(data=[[10, 20 ,30],
                 [15, 20 ,30],
                 [15, 25 ,30]], name='layer_vector_graphics', layer_type='line')

# Open browser
webbrowser.open(str(viewer))

if not sys.flags.interactive:
    neuroglancer.block()