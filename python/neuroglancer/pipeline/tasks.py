from __future__ import print_function
from collections import defaultdict
import json
import itertools
import io
import os
import re
from tempfile import NamedTemporaryFile

import h5py
import blosc
import numpy as np
from backports import lzma
from tqdm import tqdm

from neuroglancer import chunks, downsample, downsample_scales
from neuroglancer.lib import xyzrange, min2, max2, Vec, Bbox 
from neuroglancer.pipeline import Storage, Precomputed, RegisteredTask
from neuroglancer.pipeline.volumes import CloudVolume
from neuroglancer.pipeline import Mesher

class IngestTask(RegisteredTask):
  """Ingests and does downsampling.
     We want tasks execution to be independent of each other, so that no synchronization is
     required.
     The downsample scales should be such that the lowest resolution chunk should be able
     to be produce from the data available.
  """
  def __init__(self, chunk_path, chunk_encoding, layer_path):
    super(IngestTask, self).__init__(chunk_path, chunk_encoding, layer_path)
    self.chunk_path = chunk_path
    self.chunk_encoding = chunk_encoding
    self.layer_path = layer_path

    self._volume = None # defer until execution
    self._bounds = None # defer until execution

  def execute(self):
    self._volume = CloudVolume(self.layer_path, mip=0)
    self._bounds = Bbox.from_filename(self.chunk_path)
    data = self._download_input_chunk()
    # self._bounds = self._bounds.transpose()
    data = chunks.decode(data, self.chunk_encoding)
    self._create_chunks(data)

  def _download_input_chunk(self):
    storage = Storage(self.layer_path, n_threads=0)
    relpath = 'build/{}'.format(self._bounds.to_filename())
    return storage.get_file(relpath)

  def _create_chunks(self, image):
    vol = self._volume

    fullscales = downsample_scales.compute_plane_downsampling_scales(image.shape[:3], 
      max_downsampled_size=max(self._volume.underlying[:2] * 2)
    )
    factors = downsample.scale_series_to_downsample_factors(fullscales)
    downsamplefn = downsample.method(vol.layer_type)

    vol.mip = 0
    vol.upload_image(image, self._bounds.minpt)

    for factor3 in factors:
      vol.mip += 1

      image = downsamplefn(image, factor3)
      vol.upload_image(image, self._bounds.minpt / vol.downsample_ratio)

class DownsampleTask(RegisteredTask):
  def __init__(self, layer_path, mip, shape, offset, axis='z'):
    super(DownsampleTask, self).__init__(layer_path, mip, shape, offset, axis)
    self.layer_path = layer_path
    self.mip = mip
    self.shape = Vec(*shape)
    self.offset = Vec(*offset)
    self.axis = axis

    self._volume = None
    self._bounds = None
    
  def execute(self):
    self._volume = CloudVolume(self.layer_path, self.mip)
    vol = self._volume

    self._bounds = Bbox( self.offset, self.shape + self.offset )
    self._bounds = Bbox.clamp(self._bounds, vol.bounds)
    
    image = vol[ self._bounds.to_slices() ]

    self.downsample(vol, image)

  def downsample(self, vol, image):

    shape = min2(Vec(*image.shape[:3]), self._bounds.size3())

    # need to use self.shape here. shape or self._bounds means edges won't generate as many mip levels
    fullscales = downsample_scales.compute_plane_downsampling_scales(
      size=self.shape, 
      preserve_axis=self.axis, 
      max_downsampled_size=(min(*vol.underlying) * 2),
    )
    factors = downsample.scale_series_to_downsample_factors(fullscales)

    if len(factors) == 0:
      print("No factors generated for shape: {}, image: {}".format(self.shape, shape))

    downsamplefn = downsample.method(vol.layer_type)

    original_mip = vol.mip
    total_factor = Vec(1,1,1)

    for factor3 in factors:
      vol.mip += 1
      image = downsamplefn(image, factor3)
      total_factor *= factor3
      vol.upload_image(image, self._bounds.minpt / total_factor)

class QuantizeAffinitiesTask(RegisteredTask):
  def __init__(self, source_layer_path, dest_layer_path, shape, offset):
    super(QuantizeAffinitiesTask, self).__init__(source_layer_path, dest_layer_path, shape, offset)
    self.source_layer_path = source_layer_path
    self.dest_layer_path = dest_layer_path
    self.shape = Vec(*shape)
    self.offset = Vec(*offset)

    self.mip = 0
    self.axis = 'z'

    self._bounds = None

  def execute(self):
    srcvol = CloudVolume(self.source_layer_path, mip=0)
  
    self._bounds = Bbox( self.offset, self.shape + self.offset )
    self._bounds = Bbox.clamp(self._bounds, srcvol.bounds)
    
    image = srcvol[ self._bounds.to_slices() ][ :, :, :, :1 ] # only use x affinity
    image = (image * 255.0).astype(np.uint8)

    print(self.dest_layer_path)
    
    destvol = CloudVolume(self.dest_layer_path, mip=0)
    destvol[ self._bounds.to_slices() ] = image

    self.downsample(destvol, image)

  def downsample(self, vol, image):

    shape = min2(Vec(*image.shape[:3]), self._bounds.size3())

    # need to use self.shape here. shape or self._bounds means edges won't generate as many mip levels
    fullscales = downsample_scales.compute_plane_downsampling_scales(
      size=self.shape, 
      preserve_axis=self.axis, 
      max_downsampled_size=(min(*vol.underlying) * 2),
    )
    factors = downsample.scale_series_to_downsample_factors(fullscales)

    if len(factors) == 0:
      print("No factors generated for shape: {}, image: {}".format(self.shape, shape))

    downsamplefn = downsample.method(vol.layer_type)

    original_mip = vol.mip
    total_factor = Vec(1,1,1)

    for factor3 in factors:
      vol.mip += 1
      image = downsamplefn(image, factor3)
      total_factor *= factor3
      vol.upload_image(image, self._bounds.minpt / total_factor)

class MeshTask(RegisteredTask):

  def __init__(self, shape, offset, layer_path, mip=0, simplification_factor=100, max_simplification_error=1000000):
    super(MeshTask, self).__init__(shape, offset, layer_path, mip, simplification_factor, max_simplification_error)
    self.shape = Vec(*shape)
    self.offset = Vec(*offset)
    self.mip = mip
    self.layer_path = layer_path
    self.lod = 0 # level of detail -- to be implemented
    self.simplification_factor = simplification_factor
    self.max_simplification_error = max_simplification_error

  def execute(self):
    self._mesher = Mesher()

    self._volume = CloudVolume(self.layer_path, self.mip)
    self._bounds = Bbox( self.offset, self.shape + self.offset )
    self._bounds = Bbox.clamp(self._bounds, self._volume.bounds)
    
    if 'mesh' not in self._volume.info:
      raise ValueError("The mesh destination is not present in the info file.")

    self._data = self._volume[self._bounds.to_slices()] # chunk_position includes a 1 pixel overlap
    self._compute_meshes()

  def _compute_meshes(self):
    with Storage(self.layer_path) as storage:
      data = self._data
      self._mesher.mesh(data.flatten(), *data.shape[:3])
      for obj_id in self._mesher.ids():
        storage.put_file(
          file_path='{}/{}:{}:{}'.format(self._volume.info['mesh'], obj_id, self.lod, self._bounds.to_filename()),
          content=self._create_mesh(obj_id),
          compress=True,
        )

  def _create_mesh(self, obj_id):
    mesh = self._mesher.get_mesh(obj_id, 
      simplification_factor=self.simplification_factor, 
      max_simplification_error=self.max_simplification_error
    )
    vertices = self._update_vertices(np.array(mesh['points'], dtype=np.float32)) 
    vertex_index_format = [
      np.uint32(len(vertices) / 3), # Number of vertices ( each vertex is three numbers (x,y,z) )
      vertices,
      np.array(mesh['faces'], dtype=np.uint32)
    ]
    return b''.join([ array.tobytes() for array in vertex_index_format ])

  def _update_vertices(self, points):
    # zlib meshing multiplies verticies by two to avoid working with floats like 1.5
    # but we need to recover the exact position for display
    points /= 2.0
    resolution = self._volume.resolution
    xmin, ymin, zmin = self._bounds.minpt
    points[0::3] = (points[0::3] + xmin) * resolution.x 
    points[1::3] = (points[1::3] + ymin) * resolution.y 
    points[2::3] = (points[2::3] + zmin) * resolution.z 
    return points

class MeshManifestTask(RegisteredTask):
  """
  Finalize mesh generation by post-processing chunk fragment
  lists into mesh fragment manifests.
  These are necessary for neuroglancer to know which mesh
  fragments to download for a given segid.
  """
  def __init__(self, layer_path, lod):
    super(MeshManifestTask, self).__init__(layer_path, lod)
    self.layer_path = layer_path
    self.lod = lod

  def execute(self):
    with Storage(self.layer_path) as storage:
      self._download_info(storage)
      self._download_input_chunk(storage)

  def _download_info(self, storage):
    self._info = json.loads(storage.get_file('info'))
    
  def _download_input_chunk(self, storage):
    """
    Assumes that list blob is lexicographically ordered
    """
    last_id = 0
    last_fragments = []
    for filename in storage.list_files(prefix='mesh/'):
      match = re.match(r'(\d+):(\d+):(.*)$', filename)
      if not match: # a manifest file will not match
        continue
      _id, lod, chunk_position = match.groups()
      _id = int(_id); lod = int(lod)
      if lod != self.lod:
        continue

      if last_id != _id:
        storage.put_file(
          file_path='{}/{}:{}'.format(self._info['mesh'],last_id, self.lod),
          content=json.dumps({"fragments": last_fragments})
        ).wait()
        
        last_id = _id
        last_fragments = []

      last_fragments.append('{}:{}:{}'.format(_id, lod, chunk_position))

class BigArrayTask(RegisteredTask):
  def __init__(self, layer_path, chunk_path, chunk_encoding, version):
    super(BigArrayTask, self).__init__(layer_path, chunk_path, chunk_encoding, version)
    self.layer_path = layer_path
    self.chunk_path = chunk_path
    self.chunk_encoding = chunk_encoding
    self.version = version
  
  def execute(self):
    self._parse_chunk_path()
    self._storage = Storage(self.layer_path)
    self._download_input_chunk()
    self._upload_chunk()

  def _parse_chunk_path(self):
    if self.version == 'zfish_v0/affinities':
      match = re.match(r'^.*/bigarray/block_(\d+)-(\d+)_(\d+)-(\d+)_(\d+)-(\d+)_1-3.h5$',
        self.chunk_path)
    elif self.version == 'zfish_v0/image' or self.version == 'pinky_v0/image':
      match = re.match(r'^.*/bigarray/(\d+):(\d+)_(\d+):(\d+)_(\d+):(\d+)$',
        self.chunk_path)
    else:
      raise NotImplementedError(self.version)

    (self._xmin, self._xmax,
     self._ymin, self._ymax,
     self._zmin, self._zmax) = match.groups()
     
    self._xmin = int(self._xmin)
    self._xmax = int(self._xmax)
    self._ymin = int(self._ymin)
    self._ymax = int(self._ymax)
    self._zmin = int(self._zmin)
    self._zmax = int(self._zmax)
    self._filename = self.chunk_path.split('/')[-1]

  def _download_input_chunk(self):
    string_data = self._storage.get_file(os.path.join('bigarray',self._filename))
    if self.version == 'zfish_v0/affinities':
      self._data = self._decode_hdf5(string_data)
    elif self.version == 'zfish_v0/image':
      self._data = self._decode_blosc(string_data, shape=[2048, 2048, 128])
    elif self.version == 'pinky_v0/image':
      self._data = self._decode_blosc(string_data, shape=[2048, 2048, 64])
    else:
      raise NotImplementedError(self.version)

  def _decode_blosc(self, string, shape):
    seeked = blosc.decompress(string[10:])
    arr =  np.fromstring(seeked, dtype=np.uint8).reshape(
      shape[::-1]).transpose((2,1,0))
    return np.expand_dims(arr,3)


  def _decode_hdf5(self, string):
    with NamedTemporaryFile(delete=False) as tmp:
      tmp.write(string)
      tmp.close()
      with h5py.File(tmp.name,'r') as h5:
        return np.transpose(h5['img'][:], axes=(3,2,1,0))

  def _upload_chunk(self):
    if self.version == 'zfish_v0/affinities':
      shape = [313472, 193664, 1280]
      offset = [14336, 11264, 16384]
    elif self.version == 'zfish_v0/image':
      shape = [69632, 34816, 1280]
      offset = [14336, 12288, 16384]
    elif self.version == 'pinky_v0/image':
      shape = [100352, 55296, 1024]
      offset = [2048, 14336, 16384]
    else:
      raise NotImplementedError(self.version)

    xmin = self._xmin - offset[0] - 1
    xmax = min(self._xmax - offset[0], shape[0])
    ymin = self._ymin - offset[1] - 1
    ymax = min(self._ymax - offset[1], shape[1])
    zmin = self._zmin - offset[2] - 1
    zmax = min(self._zmax - offset[2], shape[2])

    #bigarray chunk has padding to fill the volume
    chunk = self._data[:xmax-xmin, :ymax-ymin, :zmax-zmin, :]
    filename = 'build/{:d}-{:d}_{:d}-{:d}_{:d}-{:d}'.format(
      xmin, xmax, ymin, ymax, zmin, zmax)
    encoded = self._encode(chunk, self.chunk_encoding)
    self._storage.put_file(filename, encoded)
    self._storage.wait_until_queue_empty()

  def _encode(self, chunk, encoding):
    if encoding == "jpeg":
      return chunks.encode_jpeg(chunk)
    elif encoding == "npz":
      return chunks.encode_npz(chunk)
    elif encoding == "npz_uint8":
      chunk = chunk * 255
      chunk = chunk.astype(np.uint8)
      return chunks.encode_npz(chunk)
    elif encoding == "raw":
      return chunks.encode_raw(chunk)
    else:
      raise NotImplementedError(encoding)

class HyperSquareTask(RegisteredTask):
  def __init__(self, bucket_name, dataset_name, layer_name, 
      volume_dir, layer_type, overlap, world_bounds, resolution):

    self.bucket_name = bucket_name
    self.dataset_name = dataset_name
    self.layer_name = layer_name
    self.volume_dir = volume_dir
    self.layer_type = layer_type
    self.overlap = Vec(*overlap)

    if type(world_bounds) is Bbox:
      self.world_bounds = world_bounds
    else:
      self.world_bounds = Bbox.from_list(world_bounds)

    self.resolution = Vec(*resolution)

    self._volume_cloudpath = 'gs://{}/{}'.format(self.bucket_name, self.volume_dir)
    self._bucket = None
    self._metadata = None
    self._bounds = None

  def execute(self):
    client = storage.Client.from_service_account_json(
      lib.credentials_path(), project=lib.GCLOUD_PROJECT_NAME
    )
    self._bucket = client.get_bucket(self.bucket_name)
    self._metadata = meta = self._download_metadata()

    self._bounds = Bbox(
      meta['physical_offset_min'], # in voxels
      meta['physical_offset_max']
    )

    shape = Vec(*meta['chunk_voxel_dimensions'])
    shape = Vec(shape.x, shape.y, shape.z, 1)

    if self.layer_type == 'image':
      dtype = meta['image_type'].lower()
      cube = self._materialize_images(shape, dtype)
    elif self.layer_type == 'segmentation':
      dtype = meta['segment_id_type'].lower()
      cube = self._materialize_segmentation(shape, dtype)
    else:
      dtype = meta['affinity_type'].lower()
      return NotImplementedError("Don't know how to get the images for this layer.")

    self._upload_chunk(cube, dtype)

  def _download_metadata(self):
    cloudpath = '{}/metadata.json'.format(self.volume_dir)
    metadata = self._bucket.get_blob(cloudpath).download_as_string()
    return json.loads(metadata)

  def _materialize_segmentation(self, shape, dtype):
    segmentation_path = '{}/segmentation.lzma'.format(self.volume_dir)
    seg_blob = self._bucket.get_blob(segmentation_path)
    return self._decode_lzma(seg_blob.download_as_string(), shape, dtype)

  def _materialize_images(self, shape, dtype):
    cloudpaths = [ '{}/jpg/{}.jpg'.format(self.volume_dir, i) for i in xrange(shape.z) ]
    datacube = np.zeros(shape=shape, dtype=np.uint8) # x,y,z,channels

    prefix = '{}/jpg/'.format(self.volume_dir)

    blobs = self._bucket.list_blobs(prefix=prefix)
    for blob in blobs:
      z = int(re.findall(r'(\d+)\.jpg', blob.name)[0])
      imgdata = blob.download_as_string()
      datacube[:,:,z,:] = chunks.decode_jpeg(imgdata, shape=(256, 256, 1))

    return datacube

  def _decode_lzma(self, string_data, shape, dtype):
    arr = lzma.decompress(string_data)
    arr = np.fromstring(arr, dtype=dtype)
    return arr.reshape(shape[::-1]).T

  def _upload_chunk(self, datacube, dtype):
    vol = CloudVolume(self.dataset_name, self.layer_name, mip=0)
    hov = self.overlap / 2 # half overlap, e.g. 32 -> 16 in e2198
    img = datacube[ hov.x:-hov.x, hov.y:-hov.y, hov.z:-hov.z, : ] # e.g. 256 -> 224
    bounds = self._bounds.clone()

    # the boxes are offset left of zero by half overlap, so no need to 
    # compensate for weird shifts. only upload the non-overlap region.

    vol.upload_image(img, bounds.minpt)

class TransferTask(RegisteredTask):
  def __init__(self, src_path, dest_path, shape, offset):
    super(self.__class__, self).__init__(src_path, dest_path, shape, offset)
    self.src_path = src_path
    self.dest_path = dest_path
    self.shape = Vec(*shape)
    self.offset = Vec(*offset)

  def execute(self):
    srccv = CloudVolume(self.src_path)
    destcv = CloudVolume(self.dest_path)

    bounds = Bbox( self.offset, self.shape + self.offset )
    bounds = Bbox.clamp(bounds, srccv.bounds)
    
    destcv[ bounds.to_slices() ] = srccv[ bounds.to_slices() ]







