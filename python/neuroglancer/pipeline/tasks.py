from __future__ import print_function
from collections import defaultdict
import json
import itertools
import io
import os
import re
from cStringIO import StringIO
from tempfile import NamedTemporaryFile
from collections import defaultdict

import h5py
import blosc
import numpy as np
from backports import lzma
from tqdm import tqdm

from intern.remote.boss import BossRemote
from intern.resource.boss.resource import ChannelResource
from neuroglancer.pipeline.secrets import boss_credentials
from neuroglancer import chunks, downsample, downsample_scales
from neuroglancer.lib import xyzrange, min2, max2, Vec, Bbox, mkdir 
from neuroglancer.pipeline import Storage, Precomputed, RegisteredTask
from neuroglancer.pipeline.volumes import CloudVolume
# from neuroglancer.ingest.mesher import Mesher

def downsample_and_upload(image, bounds, vol, ds_shape, mip=0, axis='z', skip_first=False):
    ds_shape = min2(vol.volume_size, ds_shape)

    # sometimes we downsample a base layer of 512x512 
    # into underlying chunks of 64x64 which permits more scales
    underlying_mip = (mip + 1) if (mip + 1) in vol.available_mips else mip
    underlying_shape = vol.mip_underlying(underlying_mip).astype(np.float32)
    toidx = { 'x': 0, 'y': 1, 'z': 2 }
    preserved_idx = toidx[axis]
    underlying_shape[preserved_idx] = float('inf')

    # Need to use ds_shape here. Using image bounds means truncated 
    # edges won't generate as many mip levels
    fullscales = downsample_scales.compute_plane_downsampling_scales(
      size=ds_shape, 
      preserve_axis=axis, 
      max_downsampled_size=int(min(*underlying_shape)),
    )
    factors = downsample.scale_series_to_downsample_factors(fullscales)

    if len(factors) == 0:
      print("No factors generated. Image Shape: {}, Downsample Shape: {}, Volume Shape: {}, Bounds: {}".format(
        image.shape, ds_shape, vol.volume_size, bounds)
      )

    downsamplefn = downsample.method(vol.layer_type)

    vol.mip = mip
    if not skip_first:
      vol[ bounds.to_slices() ] = image

    new_bounds = bounds.clone()

    for factor3 in factors:
      vol.mip += 1
      image = downsamplefn(image, factor3)
      new_bounds /= factor3
      new_bounds.maxpt = new_bounds.minpt + Vec(*image.shape[:3])
      vol[ new_bounds.to_slices() ] = image

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

  def execute(self):
    volume = CloudVolume(self.layer_path, mip=0)
    bounds = Bbox.from_filename(self.chunk_path)
    image = self._download_input_chunk(bounds)
    image = chunks.decode(image, self.chunk_encoding)
    # BUG: We need to provide some kind of ds_shape independent of the image
    # otherwise the edges of the dataset may not generate as many mip levels.
    downsample_and_upload(image, bounds, volume, mip=0, ds_shape=image.shape[:3])

  def _download_input_chunk(self, bounds):
    storage = Storage(self.layer_path, n_threads=0)
    relpath = 'build/{}'.format(bounds.to_filename())
    return storage.get_file(relpath)

class DownsampleTask(RegisteredTask):
  def __init__(self, layer_path, mip, shape, offset, fill_missing=False, axis='z'):
    super(DownsampleTask, self).__init__(layer_path, mip, shape, offset, fill_missing, axis)
    self.layer_path = layer_path
    self.mip = mip
    self.shape = Vec(*shape)
    self.offset = Vec(*offset)
    self.fill_missing = fill_missing
    self.axis = axis

  def execute(self):
    vol = CloudVolume(self.layer_path, self.mip, fill_missing=self.fill_missing)
    bounds = Bbox( self.offset, self.shape + self.offset )
    bounds = Bbox.clamp(bounds, vol.bounds)
    image = vol[ bounds.to_slices() ]
    downsample_and_upload(image, bounds, vol, self.shape, self.mip, self.axis, skip_first=True)

class QuantizeAffinitiesTask(RegisteredTask):
  def __init__(self, source_layer_path, dest_layer_path, shape, offset, fill_missing=False):
    super(QuantizeAffinitiesTask, self).__init__(source_layer_path, dest_layer_path, shape, offset, fill_missing)
    self.source_layer_path = source_layer_path
    self.dest_layer_path = dest_layer_path
    self.shape = Vec(*shape)
    self.offset = Vec(*offset)
    self.fill_missing = fill_missing

  def execute(self):
    srcvol = CloudVolume(self.source_layer_path, mip=0, fill_missing=self.fill_missing)
  
    bounds = Bbox( self.offset, self.shape + self.offset )
    bounds = Bbox.clamp(bounds, srcvol.bounds)
    
    image = srcvol[ bounds.to_slices() ][ :, :, :, :1 ] # only use x affinity
    image = (image * 255.0).astype(np.uint8)

    destvol = CloudVolume(self.dest_layer_path, mip=0)
    downsample_and_upload(image, bounds, destvol, self.shape, mip=0, axis='z')

class MeshTask(RegisteredTask):
  def __init__(self, shape, offset, layer_path, mip=0, simplification_factor=100, max_simplification_error=40):
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

    self._volume = CloudVolume(self.layer_path, self.mip, bounded=False)
    self._bounds = Bbox( self.offset, self.shape + self.offset )
    self._bounds = Bbox.clamp(self._bounds, self._volume.bounds)

    # Marching cubes loves its 1vx overlaps. 
    # This avoids lines appearing between 
    # adjacent chunks.
    data_bounds = self._bounds.clone()
    data_bounds.minpt -= 1
    data_bounds.maxpt += 1

    self._mesh_dir = None
    if 'meshing' in self._volume.info:
      self._mesh_dir = self._volume.info['meshing']
    elif 'mesh' in self._volume.info:
      self._mesh_dir = self._volume.info['mesh']
    
    if not self._mesh_dir:
      raise ValueError("The mesh destination is not present in the info file.")

    self._data = self._volume[data_bounds.to_slices()] # chunk_position includes a 1 pixel overlap
    self._compute_meshes()

  def _compute_meshes(self):
    with Storage(self.layer_path) as storage:
      data = self._data[:,:,:,0].T
      self._mesher.mesh(data.flatten(), *data.shape[:3])
      for obj_id in self._mesher.ids():
        storage.put_file(
          file_path='{}/{}:{}:{}'.format(self._mesh_dir, obj_id, self.lod, self._bounds.to_filename()),
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
  def __init__(self, layer_path, prefix, lod=0):
    super(MeshManifestTask, self).__init__(layer_path, prefix)
    self.layer_path = layer_path
    self.lod = lod
    self.prefix = prefix

  def execute(self):
    with Storage(self.layer_path) as storage:
      self._info = json.loads(storage.get_file('info'))

      self.mesh_dir = None
      if 'meshing' in self._info:
        self.mesh_dir = self._info['meshing']
      elif 'mesh' in self._info:
        self.mesh_dir = self._info['mesh']

      self._generate_manifests(storage)
  
  def _get_mesh_filenames_subset(self, storage):
    prefix = '{}/{}'.format(self.mesh_dir, self.prefix)
    segids = defaultdict(list)

    for filename in storage.list_files(prefix=prefix):
      # `match` implies the beginning (^). `search` matches whole string
      matches = re.match('(\d+):(\d+):', filename)
      if not matches:
        continue

      segid, lod = matches.groups() 
      segid, lod = int(segid), int(lod)

      if lod != self.lod:
        continue

      segids[segid].append(filename)  

    return segids  

  def _generate_manifests(self, storage):
    segids = self._get_mesh_filenames_subset(storage)
    for segid, frags in tqdm(segids.items()):
      storage.put_file(
        file_path='{}/{}:{}'.format(self.mesh_dir, segid, self.lod),
        content=json.dumps({ "fragments": frags }),
        content_type='application/json',
      )

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
    
    image = srccv[ bounds.to_slices() ]
    downsample_and_upload(image, bounds, destvol, self.shape)

class WatershedRemapTask(RegisteredTask):
    """
    Take raw watershed output and using a remapping file,
    generate an aggregated segmentation. 

    The remap array is a key:value mapping where the 
    array index is the key and the value is the contents.

    You can find a script to convert h5 remap files into npy
    files in pipeline/scripts/remap2npy.py

    Required:
        map_path: path to remap file. Must be in npy or npz format.
        src_path: path to watershed layer
        dest_path: path to new layer
        shape: size of volume to remap
        offset: voxel offset into dataset
    """
    def __init__(self, map_path, src_path, dest_path, shape, offset):
        super(self.__class__, self).__init__(map_path, src_path, dest_path, shape, offset)
        self.map_path = map_path
        self.src_path = src_path
        self.dest_path = dest_path
        self.shape = Vec(*shape)
        self.offset = Vec(*offset)        

    def execute(self):
        srccv = CloudVolume(self.src_path)
        destcv = CloudVolume(self.dest_path)

        bounds = Bbox( self.offset, self.shape + self.offset )
        bounds = Bbox.clamp(bounds, srccv.bounds)

        remap = self._get_map()
        watershed_data = srccv[ bounds.to_slices() ]

        # Here's how the remapping works. Numpy has a special
        # indexing that can be used to perform the remap.
        # The remap array is a key:value mapping where the 
        # array index is the key and the value is the contents.
        # The watershed_data array contains only data values that
        # are within the length of the remap array.
        #
        # e.g. 
        #
        # remap = np.array([1,2,3]) # i.e. 0=>1, 1=>2, 1=>3
        # vals = np.array([0,1,1,1,2,0,2,1,2])
        #
        # remap[vals] # array([1, 2, 2, 2, 3, 1, 3, 2, 3])

        image = remap[watershed_data]
        downsample_and_upload(image, bounds, destcv, self.shape)

    def _get_map(self):
        layer_path, filename = os.path.split(self.map_path)

        classname = self.__class__.__name__
        lcldir = mkdir(os.path.join('/tmp/', classname))
        lclpath = os.path.join(lcldir, filename)

        if os.path.exists(lclpath):
            npy_map_file = open(lclpath, 'rb')
        else:
            with Storage(layer_path, n_threads=0) as stor:
                rawfilestr = stor.get_file(filename)

            with open(lclpath, 'wb') as f:
                f.write(rawfilestr)

            npy_map_file = StringIO(rawfilestr)

        remap = np.load(npy_map_file)
        npy_map_file.close()
        return remap

class BossTransferTask(RegisteredTask):
  """
  This is a very limited task that is used for transferring
  mip 0 data from The BOSS (https://docs.theboss.io). 
  If our needs become more sophisticated we can make a 
  BossVolume and integrate that into TransferTask.

  Of note, to initiate a transfer, write the bounds
  of the coordinate frame from your experiment into the
  destinate info file.
  """

  def __init__(self, src_path, dest_path, shape, offset):
    super(self.__class__, self).__init__(src_path, dest_path, shape, offset)
    self.src_path = src_path
    self.dest_path = dest_path
    self.shape = Vec(*shape)
    self.offset = Vec(*offset)

  def execute(self):
    match = re.match(r'^(boss)://([/\d\w_\.\-]+)/([\d\w_\.\-]+)/([\d\w_\.\-]+)/?', 
        self.src_path)
    protocol, collection, experiment, channel = match.groups()

    dest_vol = CloudVolume(self.dest_path)

    bounds = Bbox( self.offset, self.shape + self.offset )
    bounds = Bbox.clamp(bounds, dest_vol.bounds)
    # -1 b/c boss uses inclusive-exclusive bounds for their bboxes
    bounds.maxpt = Vec.clamp(
      bounds.maxpt, 
      dest_vol.bounds.minpt, 
      dest_vol.bounds.maxpt - 1
    )

    if bounds.volume() < 1:
      return

    x_rng = [ bounds.minpt.x, bounds.maxpt.x ]
    y_rng = [ bounds.minpt.y, bounds.maxpt.y ]
    z_rng = [ bounds.minpt.z, bounds.maxpt.z ]

    chan = ChannelResource(
      name=channel,
      collection_name=collection, 
      experiment_name=experiment, 
      type='image', 
      datatype=dest_vol.dtype
    )

    rmt = BossRemote(boss_credentials)
    img3d = rmt.get_cutout(chan, 0, x_rng, y_rng, z_rng).T

    print(img3d.shape, bounds.size3())

    downsample_and_upload(img3d, bounds, dest_vol, self.shape)
