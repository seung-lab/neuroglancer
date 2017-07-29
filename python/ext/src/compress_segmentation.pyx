# distutils: language = c++

# Cython interface file for wrapping the object
#
#

from libcpp.vector cimport vector
from libc.stdint cimport uint32_t, uint64_t
from libc.stdlib cimport free

import numpy as np
cimport numpy as np

# c++ interface to cython
cdef extern from "compress_segmentation.cc" namespace "neuroglancer::compress_segmentation":
  struct HashVector:
    pass

  cdef cppclass EncodedValueCache32:
    EncodedValueCache32()

  cdef cppclass EncodedValueCache64:
    EncodedValueCache64()

  void EncodeBlock[Label](
    const Label* input, 
    const ptrdiff_t input_strides[3],
    const ptrdiff_t block_size[3], 
    const ptrdiff_t actual_size[3],
    size_t base_offset, 
    size_t* encoded_bits_output,
    size_t* table_offset_output, 
    EncodedValueCache64* cache,
    vector[uint32_t]* output_vec
  )

def compress(image, block_size=(8,8,8)):
  assert len(image.shape) == 4
  assert image.shape[3] == 1
  assert image.dtype in (np.uint8, np.uint16, np.uint32, np.uint64)

  if image.dtype in (np.uint32, np.uint16, np.uint8):
    image = image.astype(np.uint64)

  image = image.squeeze() # 4D to 3D

  cdef ptrdiff_t strides[3] 
  strides[0] = 1
  strides[1] = image.shape[0] 
  strides[2] = image.shape[0] * image.shape[1]

  cdef ptrdiff_t cblock_size[3]
  cblock_size[0] = block_size[0]
  cblock_size[1] = block_size[1]
  cblock_size[2] = block_size[2]

  cdef ptrdiff_t actual_size[3]
  actual_size[0] = image.shape[0]
  actual_size[1] = image.shape[1] 
  actual_size[2] = image.shape[2]

  cdef EncodedValueCache64 *cache = new EncodedValueCache64()

  cdef np.ndarray[uint64_t, ndim=1, mode="fortran"] cimage = image.flatten('F')
  cdef uint64_t *input = &cimage[0]

  cdef vector[uint32_t] *output_vec = new vector[uint32_t]()
  cdef size_t encoded_bits_out, table_offset

  EncodeBlock[uint64_t](
    input,
    strides, # input strides
    cblock_size, # encoding block size
    actual_size, # actual size
    0, # base offset
    &encoded_bits_out, # return val for encoded bits
    &table_offset, # return val for table offset
    cache, # cache
    output_vec # return value
  )

  free(cache)
  # free(input)

  python_result = np.array(output_vec[0], dtype=np.uint32)
  free(output_vec)
  return python_result.tobytes()
   

def decompress(compressed, shape):
  pass





