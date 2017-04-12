from __future__ import print_function
import base64
from collections import defaultdict
import json
import itertools
import io
import os
import re
import sys
from tempfile import NamedTemporaryFile

import h5py
import blosc
import numpy as np
from backports import lzma
from tqdm import tqdm

from neuroglancer import chunks, downsample, downsample_scales
# from neuroglancer.ingest.mesher import Mesher
from neuroglancer.ingest.volumes import GCloudVolume

import neuroglancer.ingest.lib as lib
from neuroglancer.ingest.lib import xyzrange, min2, max2, Vec, Bbox 
from neuroglancer.ingest.lib import Storage, credentials_path, GCLOUD_PROJECT_NAME, GCLOUD_QUEUE_NAME

class CloudTask(object):
  @classmethod
  def fromjson(cls, payload, tid):
    d = json.loads(payload)
    d['tid'] = tid
    return cls(**d)

  def execute(self):
    pass

class IngestTask(CloudTask):
    """Ingests and does downsampling.
       We want tasks execution to be independent of each other, so that no synchronization is
       required.
       The downsample scales should be such that the lowest resolution chunk should be able
       to be produce from the data available.
    """
    def __init__(self, chunk_path, chunk_encoding, info_path, tid=None):
      self.chunk_path = chunk_path
      self.chunk_encoding = chunk_encoding
      self.info_path = info_path
      self.tag = 'ingest'
      self._id = tid

      self._volume = None # defer until execution
      self._bounds = None # defer until execution

    @property
    def payloadBase64(self):
      payload = json.dumps({
        'chunk_path': self.chunk_path,
        'chunk_encoding': self.chunk_encoding,
        'info_path': self.info_path,
        'tid': self._id,
      })
      return base64.b64encode(payload)

    def execute(self):
      self._volume = GCloudVolume.from_cloudpath(self.info_path, mip=0, use_secrets=True)
      self._bounds = Bbox.from_filename(self.chunk_path)
      data = self._download_input_chunk()
      data = chunks.decode(data, self.chunk_encoding)
      self._create_chunks(data)

    def _download_input_chunk(self):
      path = '{}/{}/build/{}'.format(self._volume.dataset_name, self._volume.layer, self._bounds.to_filename())
      print('downloading {}'.format(path))
      return lib.get_blob(path).download_as_string()

    def _create_chunks(self, image):
      vol = self._volume

      fullscales = downsample_scales.compute_xy_plane_downsampling_scales(image.shape[:3], max_downsampled_size=max(self._volume.underlying[:2]))

      factors = downsample.scale_series_to_downsample_factors(fullscales)

      downsamplefn = downsample.method(vol.layer_type)
      
      vol.mip = 0
      vol.upload_image(image, self._bounds.minpt)

      for factor3 in factors:
        vol.mip += 1

        image = downsamplefn(image, factor3)
        vol.upload_image(image, self._bounds.minpt / vol.downsample_ratio)

    def __repr__(self):
      return "IngestTask(chunk_path='{}', chunk_encoding='{}', info_path='{}'')".format(
        self.chunk_path, self.chunk_encoding, self.info_path
      )

class DownsampleTask(CloudTask):
  def __init__(self, dataset_name, layer, mip, shape, offset, tid=None):
    self.tag = 'downsample'

    self._id = tid

    self.dataset_name = dataset_name
    self.layer = layer
    self.mip = mip
    self.shape = Vec(*shape)
    self.offset = Vec(*offset)

    self._volume = None
    self._bounds = None
        
  @property
  def payloadBase64(self):
    payload = json.dumps({
      'dataset_name': self.dataset_name,
      'layer': self.layer,
      'mip': self.mip,
      'shape': list(self.shape),
      'offset': list(self.offset),
      'tid': self._id,
    })
    return base64.b64encode(payload)
    
  def execute(self):
    self._volume = GCloudVolume(self.dataset_name, self.layer, self.mip, use_secrets=True, use_ls=False, cache_files=True)
    vol = self._volume

    self._bounds = Bbox( self.offset, self.shape + self.offset )
    self._bounds = Bbox.clamp(self._bounds, vol.bounds)

    image = vol[ self._bounds.to_slices() ]
    shape = min2(Vec(*image.shape[:3]), self._bounds.size3())

    fullscales = downsample_scales.compute_xy_plane_downsampling_scales(shape)
    factors = downsample.scale_series_to_downsample_factors(fullscales)

    downsamplefn = downsample.method(vol.layer_type)

    original_mip = vol.mip
    total_factor = Vec(1,1,1)

    for factor3 in factors:
      vol.mip += 1
      image = downsamplefn(image, factor3)
      total_factor *= factor3
      vol.upload_image(image, self._bounds.minpt / total_factor)

  def __repr__(self):
    return "DownsampleTask({},{},{},{},{})".format(
      self._volume.dataset_name, self._volume.layer, self._volume.mip, self._bounds.size3(), self._bounds.minpt
    )

class MeshTask(CloudTask):

  def __init__(self, chunk_position, info_path, lod=0, simplification=128, segments=[], tid=None):
    
    self._id = tid
    self.chunk_position = chunk_position
    self.info_path = info_path
    self.lod = lod
    self.simplification = simplification
    self.segments = segments
    self.tag = 'mesh'

  @property
  def payloadBase64(self):
    payload = json.dumps({
      'chunk_position': self.chunk_position,
      'info_path': self.info_path,
      'lod': self.lod,
      'simplification': self.simplification,
      'segments': self.segments,
      'tid': self._id,
    })
    return base64.b64encode(payload)

  def execute(self):
    self._mesher = Mesher()
    self._bounds = Bbox.from_filename(self.chunk_position)
    self._volume = GCloudVolume.from_cloudpath(
      self.info_path, mip=0, cache_files=False, use_ls=False, use_secrets=True
    )
    
    if 'mesh' not in self._volume.info:
      raise ValueError("The mesh destination is not present in the info file.")

    self._data = self._volume[self._bounds.to_slices()] # chunk_position includes a 1 pixel overlap
    self._compute_meshes()

  def _compute_meshes(self):
    storage = Storage(self._volume.dataset_name, self._volume.layer, compress=True)
    
    data = self._data.T
    self._mesher.mesh(data.flatten(), *data.shape)
    for obj_id in tqdm(self._mesher.ids()):
      storage.add_file(
        filename='{}:{}:{}'.format(obj_id, self.lod, self.chunk_position),
        content=self._create_mesh(obj_id),
      )
    storage.flush(self._volume.info['mesh'])

  def _create_mesh(self, obj_id):
    mesh = self._mesher.get_mesh(obj_id, simplification_factor=self.simplification, max_simplification_error=1000000)
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
    resolution = self._volume.mip_resolution(0)
    xmin, ymin, zmin = self._bounds.minpt
    points[0::3] = (points[0::3] + xmin) * resolution.x 
    points[1::3] = (points[1::3] + ymin) * resolution.y 
    points[2::3] = (points[2::3] + zmin) * resolution.z 
    return points

  def __repr__(self):
    return "MeshTask(chunk_position='{}', info_path='{}', lod={}, simplification={}, segments={})".format(
      self.chunk_position, self.info_path, self.lod, self.simplification, self.segments)

class MeshManifestTask(CloudTask):
    """
    Finalize mesh generation by post-processing chunk fragment
    lists into mesh fragment manifests.
    These are necessary for neuroglancer to know which mesh
    fragments to download for a given segid.
    """
    def __init__(self, info_path, lod, tid=None):
      self._id = tid
      self.info_path = info_path
      self.lod = lod
      self.tag = 'mesh_manifest'
      
    @property
    def payloadBase64(self):
      payload = json.dumps({
        'info_path': self.info_path,
        'lod': self.lod,
        'tid': self._id,
      })
      return base64.b64encode(payload)

    def execute(self):
      self._parse_info_path()
      self._storage = Storage(self._dataset_name, self._layer_name, compress=True)
      self._download_info()
      self._download_input_chunk()

    def _parse_info_path(self):
      match = re.match(r'^.*/([^//]+)/([^//]+)/info$', self.info_path)
      self._dataset_name, self._layer_name = match.groups()

    def _download_info(self):
      path = '{}/{}/info'.format(self._dataset_name, self._layer_name)
      info_string = lib.get_blob(path, use_secrets=True).download_as_string()
      self._info = json.loads(info_string)
        
    def _download_input_chunk(self):
      """
      Assumes that list blob is lexicographically ordered
      """
      last_id = 0
      last_fragments = []
      for blob in self._storage.list_blobs(prefix='snemi3d_v0/segmentation/mesh'):
        match = re.match(r'.*/(\d+):(\d+):(.*)$', blob.name)
        if not match: # a manifest file will not match
          continue
        _id, lod, chunk_position = match.groups()
        _id = int(_id); lod = int(lod)
        if lod != self.lod:
          continue

        if last_id != _id:
          self._storage.add_file(
            filename='{}:{}'.format(last_id, self.lod),
            content=json.dumps({"fragments": last_fragments}))
          last_id = _id
          last_fragments = []

        last_fragments.append('{}:{}:{}'.format(_id, lod, chunk_position))
      self._storage.flush(self._info['mesh'])

    def __repr__(self):
      return "MeshManifestTask(info_path='{}', lod={})".format(
        self.info_path, self.lod)


class BigArrayTask(CloudTask):
  def __init__(self, chunk_path, chunk_encoding, version, tid=None):
    self._id = tid
    self.chunk_path = chunk_path
    self.chunk_encoding = chunk_encoding
    self.version = version
    self.tag = 'bigarray'  

  @property
  def payloadBase64(self):
    payload = json.dumps({
      'chunk_path': self.chunk_path,
      'chunk_encoding': self.chunk_encoding,
      'version': self.version,
      'tid': self._id,
    })
    return base64.b64encode(payload)

  def execute(self):
    self._parse_chunk_path()
    self._storage = Storage(self._dataset_name, self._layer_name, compress=False)
    self._download_input_chunk()
    self._upload_chunk()
    # self._delete_data()

  def _parse_chunk_path(self):
    if self.version == 'zfish_v0/affinities':
        match = re.match(r'^.*/([^//]+)/([^//]+)/bigarray/block_(\d+)-(\d+)_(\d+)-(\d+)_(\d+)-(\d+)_1-3.h5$',
            self.chunk_path)
    elif self.version == 'zfish_v0/image' or self.version == 'pinky_v0/image':
        match = re.match(r'^.*/([^//]+)/([^//]+)/bigarray/(\d+):(\d+)_(\d+):(\d+)_(\d+):(\d+)$',
            self.chunk_path)
    else:
        raise NotImplementedError(self.version)

    (self._dataset_name, self._layer_name, 
     self._xmin, self._xmax,
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
    self._datablob = self._storage.get_blob(
        '{}/{}/bigarray/{}'.format(self._dataset_name, self._layer_name, self._filename)) \
    
    string_data = self._datablob.download_as_string()
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
        return h5['img'][:].T

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
    filename = '{:d}-{:d}_{:d}-{:d}_{:d}-{:d}'.format(
        xmin, xmax, ymin, ymax, zmin, zmax)
    encoded = chunks.encode(chunk, self.chunk_encoding)
    self._storage.add_file(filename, encoded)
    self._storage.flush('build')

  def _delete_data(self):
    self._datablob.delete()

  def __repr__(self):
    return "BigArrayTask(chunk_path='{}, chunk_encoding='{}', version='{}')".format(
        self.chunk_path, self.chunk_encoding, self.version)

class HyperSquareTask(CloudTask):
  def __init__(self, bucket_name, dataset_name, layer, 
     volume_dir, layer_type, overlap, world_bounds, resolution, tid=None):

    self._id = tid
    self.tag = 'hypersquare'

    self.bucket_name = bucket_name
    self.dataset_name = dataset_name
    self.layer_name = layer
    self.volume_dir = volume_dir
    self.layer_type = layer_type
    self.overlap = Vec(*overlap)

    if type(world_bounds) is Bbox:
      self.world_bounds = world_bounds
    else:
      self.world_bounds = Bbox.from_list(self.world_bounds)

    self.resolution = Vec(*resolution)

    self._use_secrets = True

    self._volume_cloudpath = 'gs://{}/{}'.format(self.bucket_name, self.volume_dir)
    self._bucket = None
    self._metadata = None
    self._bounds = None

  @property
  def payloadBase64(self):
    payload = json.dumps({
      'dataset_name': self.dataset_name,
      'layer_name': self.layer_name,
      'volume_dir': self.volume_dir,
      'layer_type': self.layer_type,
      'world_bounds': self.world_bounds.to_list(),
      'resolution': list(self.resolution),
      'tid': self._id,
    })
    return base64.b64encode(payload)

  def execute(self):
    self._bucket = lib.get_bucket(use_secrets=self._use_secrets)
    self._metadata = meta = self._download_metadata()

    self._bounds = Bbox(
      meta['physical_offset_min'], # in voxels
      meta['physical_offset_max']
    )

    shape = Vec(*meta['chunk_voxel_dimensions'])

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
    cloudpath = '{}/metadata.json'.format(self._volume_cloudpath)
    metadata = self._bucket.get_blob(cloudpath).download_as_string()
    return json.loads(metadata)

  def _materialize_segmentation(self, shape, dtype):
    segmentation_path = '{}/segmentation.lzma'.format(self._volume_cloudpath)
    seg_blob = lib.get_blob(segmentation_path, use_secrets=self._use_secrets)
    return self._decode_lzma(seg_blob.download_as_string())

  def _materialize_images(self, shape, dtype):
    cloudpaths = [ '{}/jpg/{}.jpg'.format(self._volume_cloudpath, i) for i in xrange(shape.z) ]
    datacube = np.zeros(shape=shape, dtype=np.uint8) # x,y,z,channels

    blobs = self._bucket.list_blobs(prefix='{}/jpg'.format(self._volume_cloudpath))
    for blob in blobs:
      z = int(re.findall(r'(\d+)\.jpg', blob.name)[0])
      imgdata = blob.download_as_string()
      datacube[:,:,z] = chunks.decode_jpeg(imgdata).T

    return datacube

  def _decode_lzma(self, string_data, shape, dtype):
    arr = lzma.decompress(string_data)
    arr = np.fromstring(arr, dtype=dtype)
    return arr.reshape(shape[::-1]).T

  def _upload_chunk(self, datacube):
    vol = GCloudVolume(self.dataset_name, self.layer_type, 0, use_secrets=self._use_secrets)
    bounds = self._bounds.round_to_chunk_size( vol.underlying ).astype(int)

    lp = bounds.minpt - self._bounds.minpt
    hp = bounds.maxpt - self._bounds.minpt

    img = datacube[ lp.x:hp.x, lp.y:hp.y, lp.z:hp.z ]

    vol.upload_image(img, bounds.minpt)
    vol.commitData()

  def __repr__(self):
    return "HyperSquareTask({}, {}, {}, {}, {}, {}, {}, {}, {})".format(
      self.bucket_name, self.dataset_name, self.layer, self.volume_dir, 
      self.layer_type, self.overlap, self.world_bounds, self.resolution, 
      self._id
    )

class TaskQueue(object):
  """
  The standard usage is that a client calls lease to get the next available task,
  performs that task, and then calls task.delete on that task before the lease expires.
  If the client cannot finish the task before the lease expires,
  and has a reasonable chance of completing the task,
  it should call task.update before the lease expires.

  If the client completes the task after the lease has expired,
  it still needs to delete the task. 

  Tasks should be designed to be idempotent to avoid errors 
  if multiple clients complete the same task.
  """
  class QueueEmpty(LookupError):
    def __init__(self):
      super(LookupError, self).__init__('Queue Empty')

  def __init__(self, project=GCLOUD_PROJECT_NAME, queue_name=GCLOUD_QUEUE_NAME, local=True):
    self._project = 's~' + project # unsure why this is necessary
    self._queue_name = queue_name

    if local:
      from oauth2client import service_account
      self._credentials = service_account.ServiceAccountCredentials \
      .from_json_keyfile_name(credentials_path())
    else:
      from oauth2client.client import GoogleCredentials
      self._credentials = GoogleCredentials.get_application_default()

    from googleapiclient.discovery import build
    self.api = build('taskqueue', 'v1beta2', credentials=self._credentials).tasks()


  def insert(self, task):
    """
    Insert a task into an existing queue.
    """
    body = {
      "payloadBase64": task.payloadBase64,
      "queueName": self._queue_name,
      "groupByTag": True,
      "tag": task.tag,
    }

    self.api.insert(
      project=self._project,
      taskqueue=self._queue_name,
      body=body,
    ).execute(num_retries=6)

  def get(self):
    """
    Gets the named task in a TaskQueue.
    """
    raise NotImplemented

  # def list(self):
  #   """
  #   Lists all non-deleted Tasks in a TaskQueue, 
  #   whether or not they are currently leased, up to a maximum of 100.
  #   """
  #   print self.api.list(project=self._project, taskqueue=self._queue_name).execute(num_retries=6)

  def update(self, task):
    """
    Update the duration of a task lease.
    Required query parameters: newLeaseSeconds
    """
    raise NotImplemented

  def lease(self, tag=None):
    """
    Acquires a lease on the topmost N unowned tasks in the specified queue.
    Required query parameters: leaseSecs, numTasks
    """
    
    tasks = self.api.lease(
        project=self._project,
        taskqueue=self._queue_name,
        numTasks=1,
        leaseSecs=600,
        groupByTag=(tag is not None),
        tag=tag,
      ).execute(num_retries=6)

    if not 'items' in tasks:
        raise TaskQueue.QueueEmpty
      
    task_json = tasks['items'][0]
        
    tags = {
      'ingest': IngestTask,
      'downsample': DownsampleTask,
      'mesh': MeshTask,
      'mesh_manifest': MeshManifestTask,
      'bigarray': BigArrayTask,
      'hypersquare': HyperSquareTask,
    }

    cloud_task_type = tags[task_json['tag']]
    decoded_json = base64.b64decode(task_json['payloadBase64']).encode('ascii')

    return cloud_task_type.fromjson(decoded_json, tid=task_json['id'])

  def patch(self):
    """
    Update tasks that are leased out of a TaskQueue.
    Required query parameters: newLeaseSeconds
    """
    raise NotImplemented

  def delete(self, task):
    """Deletes a task from a TaskQueue."""
    self.api.delete(
      project=self._project,
      taskqueue=self._queue_name,
      task=task._id,
    ).execute(num_retries=6)


if __name__ == '__main__':
    tq = TaskQueue()
    t = BigArrayTask(
        chunk_path='gs://neuroglancer/zfish_v0/affinities/bigarray/block_14337-15360_18433-19456_16385-16512_1-3.h5',
        chunk_encoding='npz_uint8',
        version='zfish_affinities')
    t.execute()
    # tq.delete(t)
