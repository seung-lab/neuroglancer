from __future__ import print_function
import copy
from itertools import product
from functools import reduce
import json
import math
import re
import os
import copy

import numpy as np
from tqdm import tqdm

from neuroglancer import downsample_scales, chunks
from neuroglancer.lib import Vec, Bbox, max2, min2, xyzrange
from neuroglancer.pipeline import Storage, TaskQueue
from neuroglancer.pipeline.tasks import (BigArrayTask, IngestTask,
     HyperSquareTask, MeshTask, MeshManifestTask, DownsampleTask, 
     QuantizeAffinitiesTask)
from neuroglancer.pipeline.volumes import HDF5Volume, CloudVolume

def create_ingest_task(storage, task_queue):
    """
    Creates one task for each ingest chunk present in the build folder.
    It is required that the info file is already placed in order for this task
    to run succesfully.
    """
    for filename in storage.list_files(prefix='build/'):
        t = IngestTask(
          chunk_path=storage.get_path_to_file('build/'+filename),
          chunk_encoding='npz',
          layer_path=storage.layer_path,
        )
        task_queue.insert(t)

def create_bigarray_task(storage, task_queue):
    """
    Creates one task for each bigarray chunk present in the bigarray folder.
    These tasks will convert the bigarray chunks into chunks that ingest tasks are able to understand.
    """
    for filename in tqdm(storage.list_blobs(prefix='bigarray/')):   
        t = BigArrayTask(
            chunk_path=storage.get_path_to_file('bigarray/'+filename),
            chunk_encoding='npz', #npz_uint8 to convert affinites float32 affinties to uint8
            version='{}/{}'.format(storage._path.dataset_name, storage._path.layer_name))
        task_queue.insert(t)

def compute_bigarray_bounding_box(storage):
    """
    There are many versions of bigarray which have subtle differences.
    Given that it is unlikely that we are migrating from the bigarray format to the
    precomputed chunks once, it is unlikely that we will use these methods in the future.
    We decided to write the shape and offset for each 'version' in tasks.py which can
    be computed using this function.
    """
    abs_x_min = abs_y_min = abs_z_min = float('inf')
    abs_x_max = abs_y_max = abs_z_max = 0
    for filename in tqdm(storage.list_files(prefix='bigarray/')):
        match = re.match(r'(\d+):(\d+)_(\d+):(\d+)_(\d+):(\d+)$', filename)
        (_, _, 
        x_min, x_max,
        y_min, y_max,
        z_min, z_max) = match.groups()
        abs_x_min = min(int(x_min), abs_x_min)
        abs_y_min = min(int(y_min), abs_y_min)
        abs_z_min = min(int(z_min), abs_z_min)
        abs_x_max = max(int(x_max), abs_x_max)
        abs_y_max = max(int(y_max), abs_y_max)
        abs_z_max = max(int(z_max), abs_z_max)       
    print('shape', [abs_x_max-abs_x_min+1,
                    abs_y_max-abs_y_min+1,
                    abs_z_max-abs_z_min+1])
    print('offset', [abs_x_min-1, abs_y_min-1, abs_z_min-1])

def compute_build_bounding_box(storage):
    bboxes = []
    for filename in tqdm(storage.list_files(prefix='build/'), desc='Computing Build Bounds'):
        bbox = Bbox.from_filename(filename) 
        bboxes.append(bbox)

    bounds = Bbox.expand(*bboxes)
    chunk_size = reduce(max2, map(lambda bbox: bbox.size3(), bboxes))

    print('bounds={} (size: {}); chunk_size={}'.format(bounds, bounds.size3(), chunk_size))
  
    return bounds, chunk_size

def get_build_data_type_and_shape(storage):
    for filename in storage.list_files(prefix='build/'):
        arr = chunks.decode_npz(storage.get_file('build/'+filename))
        return arr.dtype.name, arr.shape[3] #num_channels

def create_info_file_from_build(layer_path, layer_type, resolution, encoding):
  assert layer_type in ('image', 'segmentation', 'affinity')

  with Storage(layer_path) as storage:
    bounds, build_chunk_size = compute_build_bounding_box(storage)
    data_type, num_channels = get_build_data_type_and_shape(storage)

  neuroglancer_chunk_size = find_closest_divisor(build_chunk_size, closest_to=[64,64,64])

  info = CloudVolume.create_new_info(
    num_channels=num_channels, 
    layer_type=layer_type, 
    data_type=data_type, 
    encoding=encoding, 
    resolution=resolution, 
    voxel_offset=bounds.minpt, 
    volume_size=bounds.size3(),
    mesh=(layer_type == 'segmentation'), 
    chunk_size=neuroglancer_chunk_size,
  )

  scale_ratios = downsample_scales.compute_plane_downsampling_scales(
    size=build_chunk_size,
    max_downsampled_size=max(neuroglancer_chunk_size[:2]) * 2, # exclude z since it won't be downsampled
  )

  vol = CloudVolume.from_cloudpath(layer_path, mip=0, info=info)
  map(vol.addScale, scale_ratios)
  vol.commitInfo()
  
  return vol.info

def find_closest_divisor(to_divide, closest_to):
    def find_closest(td,ct):
        min_distance = td
        best = td
        for x in divisors(td):
            if abs(x-ct) < min_distance:
                min_distance = abs(x-ct)
                best = x
        return best
    return [find_closest(td,ct) for td, ct in zip(to_divide,closest_to)]

def divisors(n):
    for i in xrange(1, int(math.sqrt(n) + 1)):
        if n % i == 0:
            yield i
            if i*i != n:
                yield n / i

def create_downsample_scales(layer_path, mip, ds_shape, axis='z'):
  vol = CloudVolume.from_cloudpath(layer_path, mip)
  
  shape = min2(vol.volume_size, ds_shape)
  
  scales = downsample_scales.compute_plane_downsampling_scales(
    size=shape, 
    preserve_axis=axis, 
    max_downsampled_size=(min(*vol.underlying) * 2),
  )
  scales = scales[1:] # omit (1,1,1)
  scales = [ vol.downsample_ratio * Vec(*factor3) for factor3 in scales ]
  map(vol.addScale, scales)
  return vol.commitInfo()

def create_downsampling_tasks(layer_path, task_queue, mip=-1, axis='z', shape=Vec(2048, 2048, 64)):
  vol = create_downsample_scales(layer_path, mip, shape)

  for startpt in tqdm(xyzrange( vol.bounds.minpt, vol.bounds.maxpt, shape ), desc="Inserting Downsample Tasks"):
    task = DownsampleTask(
      layer_path=layer_path,
      mip=vol.mip,
      shape=shape.clone(),
      offset=startpt.clone(),
      axis=axis,
    )
    # task.execute()
    task_queue.insert(task)

def create_fixup_downsample_tasks(layer_path, task_queue, points, shape=Vec(2048, 2048, 64), mip=0, axis='z'):
  """you can use this to fix black spots from when downsample tasks fail
  by specifying a point inside each black spot.
  """
  vol = CloudVolume.from_cloudpath(layer_path, mip)
  pts = map(np.array, points)

  def nearest_offset(pt):
    return (np.floor((pt - vol.mip_voxel_offset(0)) / shape) * shape) + vol.mip_voxel_offset(0)

  offsets = map(nearest_offset, pts)

  for offset in tqdm(offsets, desc="Inserting Corrective Downsample Tasks"):
    task = DownsampleTask(
      dataset_name=dataset_name,
      layer=layer_name,
      mip=mip,
      shape=shape,
      offset=offset,
      axis=axis,
    )
    task.execute()
    # task_queue.insert(task)

def create_quantized_affinity_info(src_layer, dest_layer, shape):
  srcvol = CloudVolume.from_cloudpath(src_layer)
  
  info = copy.deepcopy(srcvol.info)
  info['num_channels'] = 1
  info['data_type'] = 'uint8'
  info['type'] = 'segmentation'
  info['scales'] = info['scales'][:1]
  info['scales'][0]['chunk_sizes'] = [[ 64, 64, 64 ]]
  return info

def create_quantized_affinity_tasks(taskqueue, src_layer, dest_layer, shape):

  info = create_quantized_affinity_info(src_layer, dest_layer, shape)
  destvol = CloudVolume.from_cloudpath(dest_layer, info=info)
  destvol.commitInfo()

  create_downsample_scales(dest_layer, mip=0, ds_shape=shape)

  for startpt in tqdm(xyzrange( destvol.bounds.minpt, destvol.bounds.maxpt, shape ), desc="Inserting QuantizeAffinities Tasks"):
    task = QuantizeAffinitiesTask(
      source_layer_path=src_layer,
      dest_layer_path=dest_layer,
      shape=shape.clone(),
      offset=startpt.clone(),
    )
    task.execute()
  # task_queue.insert(task)

def create_hypersquare_ingest_tasks(hypersquare_bucket_name, dataset_name, hypersquare_chunk_size, resolution, voxel_offset, volume_size, overlap):
  def crtinfo(layer_type, dtype, encoding):
    return CloudVolume.create_new_info(
      num_channels=1,
      layer_type=layer_type,
      data_type=dtype,
      encoding=encoding,
      resolution=resolution,
      voxel_offset=voxel_offset,
      volume_size=volume_size,
      chunk_size=[ 56, 56, 56 ],
    )

  imginfo = crtinfo('image', 'uint8', 'jpeg')
  seginfo = crtinfo('segmentation', 'uint16', 'raw')

  scales = downsample_scales.compute_plane_downsampling_scales(hypersquare_chunk_size)[1:] # omit (1,1,1)

  IMG_LAYER_NAME = 'image'
  SEG_LAYER_NAME = 'segmentation'

  imgvol = CloudVolume(dataset_name, IMG_LAYER_NAME, 0, info=imginfo)
  segvol = CloudVolume(dataset_name, SEG_LAYER_NAME, 0, info=seginfo)

  print("Creating info files for image and segmentation...")
  imgvol.commitInfo()
  segvol.commitInfo()

  world_bounds = lib.Bbox( voxel_offset, Vec(*voxel_offset) + Vec(*volume_size) )

  def crttask(volname, tasktype, layer_name):
    return HyperSquareTask(
      bucket_name=hypersquare_bucket_name,
      dataset_name=dataset_name,
      layer_name=layer_name,
      volume_dir=volname,
      layer_type=tasktype,
      overlap=overlap,
      world_bounds=world_bounds,
      resolution=resolution,
    )

  tq = TaskQueue()
  print("Listing hypersquare bucket...")
  # volumes_listing = lib.gcloud_ls('gs://{}/'.format(hypersquare_bucket_name))

  # download this from: 
  with open('e2198_volumes.json', 'r') as f:
    volumes_listing = json.loads(f.read())

  volumes_listing = [ x.split('/')[-2] for x in volumes_listing ]

  for cloudpath in tqdm(volumes_listing, desc="Creating Ingest Tasks"):
    # print(cloudpath)
    # img_task = crttask(cloudpath, 'image', IMG_LAYER_NAME)
    seg_task = crttask(cloudpath, 'segmentation', SEG_LAYER_NAME)
    # seg_task.execute()
    tq.insert(seg_task)

def upload_build_chunks(storage, volume, offset=[0, 0, 0], build_chunk_size=[1024,1024,128]):
  offset = Vec(*offset)
  shape = Vec(*volume.shape[:3])
  build_chunk_size = Vec(*build_chunk_size)

  for spt in xyzrange( (0,0,0), shape, build_chunk_size):
    ept = min2(spt + build_chunk_size, shape)
    bbox = Bbox(spt, ept)
    chunk = volume[ bbox.to_slices() ]
    bbox += offset
    filename = 'build/{}'.format(bbox.to_filename())
    storage.put_file(filename, chunks.encode_npz(chunk))
  storage.wait()

class MockTaskQueue():
    def insert(self, task):
        task.execute()
        del task

def ingest_hdf5_example():
    dataset_path='gs://neuroglancer/test_v0'
    task_queue = MockTaskQueue()
    offset = [0,0,0]
    resolution=[6,6,30]
    #ingest image
    layer_type = 'image'
    volume =  HDF5Volume('/usr/people/it2/snemi3d/image.h5', layer_type)
    storage = Storage(dataset_path+'/image', n_threads=0)
    upload_build_chunks(storage, volume, offset)
    create_info_file_from_build(storage.layer_path, layer_type, resolution=resolution, encoding='raw')
    create_ingest_task(storage, task_queue)
    create_downsampling_task(storage, task_queue)

    #ingest segmentation
    layer_type = 'segmentation'
    volume =  HDF5Volume('/usr/people/it2/snemi3d/human_labels.h5', layer_type)
    storage = Storage(dataset_path+'/segmentation', n_threads=0)
    upload_build_chunks(storage, volume, offset)
    create_info_file_from_build(storage.layer_path, layer_type, resolution=resolution, encoding='raw')
    create_ingest_task(storage, task_queue)
    create_downsampling_task(storage, task_queue)
    t = MeshTask(chunk_key=dataset_path+'/segmentation/6_6_30',
             chunk_position='0-1024_0-1024_0-51',
             layer_path=dataset_path+'/segmentation',
             lod=0, simplification=5, segments=[])
    task_queue.insert(t)
    t = MeshTask(chunk_key=dataset_path+'/segmentation/6_6_30',
             chunk_position='0-1024_0-1024_50-100',
             layer_path=dataset_path+'/segmentation',
             lod=0, simplification=5, segments=[])
    task_queue.insert(t)
    t = MeshManifestTask(layer_path=dataset_path+'/segmentation',
                     lod=0).execute()
    task_queue.insert(t)

    #ingest affinities
    # HDF5Volume does some type convertion when affinities are specified as layer type
    # but neuroglancer only has image or segmentation layer types
    volume =  HDF5Volume('/usr/people/it2/snemi3d/affinities.h5', layer_type='affinities')
    storage = Storage(dataset_path+'/affinities', n_threads=0)
    upload_build_chunks(storage, volume, offset)
    create_info_file_from_build(storage.layer_path, layer_type='image',
        resolution=resolution, encoding='raw')
    create_ingest_task(storage, task_queue)
    create_downsampling_task(storage, task_queue)

    
if __name__ == '__main__':  
  task_queue = MockTaskQueue()

  create_quantized_affinity_tasks(task_queue, 
    src_layer='s3://neuroglancer/pinky40_v11/affinitymap-jnet/',
    dest_layer='gs://neuroglancer/pinky40_v11/qaffinitymap-jnet-x/',
    shape=Vec(1024, 1024, 128),
  )



    
