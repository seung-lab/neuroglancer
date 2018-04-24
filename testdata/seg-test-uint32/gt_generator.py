from cloudvolume import CloudVolume
import numpy as np
import os

p = os.path.join(os.expanduser('~'), 'seunglab/neuroglancer/testdata/seg-test-uint32')
vol = CloudVolume('file:///{}'.format(p), mip=0)

a = np.zeros((2048, 2048, 1), np.uint32)
c_size = 512
c_range = range(0, 2048, c_size)
for k, i in enumerate(c_range): 
	a[i:i+c_size, i:i+c_size, :] = np.ones((c_size, c_size, 1), np.uint32)*(k+1)

vol[:,:,0] = a[:,:,:,np.newaxis]