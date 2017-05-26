#!/usr/bin/python

import sys

import h5py
import numpy as np

if len(sys.argv) == 1:
  print "You must specify a remap .h5 file."
  sys.exit()

in_file = sys.argv[1]
out_file = in_file.replace('.h5', '')

with h5py.File(in_file,'r') as f:
  arr = f['main'][:]

print arr.shape, arr.dtype

# These remap files are often created by julia or
# matlab which assume 1-indexing. Add a new index
# at 0 to realign with python's 0-indexing. 
arr = np.concatenate( (np.array([0]), arr) )
arr = arr.astype(np.uint32)

np.save(out_file, arr)




