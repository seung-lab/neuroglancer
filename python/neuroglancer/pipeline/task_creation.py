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
from neuroglancer.pipeline import Storage, TaskQueue, MockTaskQueue
from neuroglancer.pipeline.tasks import (BigArrayTask, IngestTask,
     HyperSquareTask, MeshTask, MeshManifestTask, DownsampleTask, 
     QuantizeAffinitiesTask, TransferTask)
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

def compute_build_bounding_box(storage, prefix='build/'):
    bboxes = []
    for filename in tqdm(storage.list_files(prefix=prefix), desc='Computing Bounds'):
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

  vol = CloudVolume(layer_path, mip=0, info=info)
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
  vol = CloudVolume(layer_path, mip)
  
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

def create_downsampling_tasks(task_queue, layer_path, mip=-1, axis='z', shape=Vec(2048, 2048, 64)):
  shape = Vec(*shape)
  vol = create_downsample_scales(layer_path, mip, shape)

  for startpt in tqdm(xyzrange( vol.bounds.minpt, vol.bounds.maxpt, shape ), desc="Inserting Downsample Tasks"):
    task = DownsampleTask(
      layer_path=layer_path,
      mip=vol.mip,
      shape=shape.clone(),
      offset=startpt.clone(),
      axis=axis,
    )
    task_queue.insert(task)
  task_queue.wait()

def create_transfer_tasks(task_queue, src_layer_path, dest_layer_path, shape=Vec(2048, 2048, 64)):
  shape = Vec(*shape)
  vol = CloudVolume(src_layer_path)

  for startpt in tqdm(xyzrange( vol.bounds.minpt, vol.bounds.maxpt, shape ), desc="Inserting Transfer Tasks"):
    task = TransferTask(
      src_path=src_layer_path,
      dest_path=dest_layer_path,
      shape=shape.clone(),
      offset=startpt.clone(),
    )
    task_queue.insert(task)
  task_queue.wait()

def compute_fixup_offsets(vol, points, shape):
  pts = map(np.array, points)

  # points are specified in high res coordinates 
  # because that's what people read off the screen.
  def nearest_offset(pt):
    return (np.floor((pt - vol.mip_voxel_offset(0)) / shape) * shape) + vol.mip_voxel_offset(0)

  return map(nearest_offset, pts)

def create_fixup_downsample_tasks(task_queue, layer_path, points, shape=Vec(2048, 2048, 64), mip=0, axis='z'):
  """you can use this to fix black spots from when downsample tasks fail
  by specifying a point inside each black spot.
  """
  vol = CloudVolume(layer_path, mip)
  offsets = compute_fixup_offsets(vol, points, shape)

  for offset in tqdm(offsets, desc="Inserting Corrective Downsample Tasks"):
    task = DownsampleTask(
      layer_path=layer_path,
      mip=mip,
      shape=shape,
      offset=offset,
      axis=axis,
    )
    # task.execute()
    task_queue.insert(task)
  task_queue.wait()

def create_quantized_affinity_info(src_layer, dest_layer, shape):
  srcvol = CloudVolume(src_layer)
  
  info = copy.deepcopy(srcvol.info)
  info['num_channels'] = 1
  info['data_type'] = 'uint8'
  info['type'] = 'segmentation'
  info['scales'] = info['scales'][:1]
  info['scales'][0]['chunk_sizes'] = [[ 64, 64, 64 ]]
  return info

def create_quantized_affinity_tasks(taskqueue, src_layer, dest_layer, shape):
  shape = Vec(*shape)

  info = create_quantized_affinity_info(src_layer, dest_layer, shape)
  destvol = CloudVolume(dest_layer, info=info)
  destvol.commitInfo()

  create_downsample_scales(dest_layer, mip=0, ds_shape=shape)

  for startpt in tqdm(xyzrange( destvol.bounds.minpt, destvol.bounds.maxpt, shape ), desc="Inserting QuantizeAffinities Tasks"):
    task = QuantizeAffinitiesTask(
      source_layer_path=src_layer,
      dest_layer_path=dest_layer,
      shape=list(shape.clone()),
      offset=list(startpt.clone()),
    )
    # task.execute()
    task_queue.insert(task)
  task_queue.wait()

def create_fixup_quantize_tasks(task_queue, src_layer, dest_layer, shape, points):
  shape = Vec(*shape)
  vol = CloudVolume(src_layer, 0)
  offsets = compute_fixup_offsets(vol, points, shape)

  for offset in tqdm(offsets, desc="Inserting Corrective Quantization Tasks"):
    task = QuantizeAffinitiesTask(
      source_layer_path=src_layer,
      dest_layer_path=dest_layer,
      shape=list(shape.clone()),
      offset=list(offset.clone()),
    )
    # task.execute()
    task_queue.insert(task)
  task_queue.wait()

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
  # task_queue = 
  # task_queue = MockTaskQueue()

  src_layer = 's3://neuroglancer/pinky40_v11/semanticmap-4/'
  dest_layer = 'gs://neuroglancer/pinky40_v11/qsemanticmap-4-x/'
  shape = Vec(1024, 1024, 128)

  points = [[67024,44548,793],[62873,41358,427],[65990,43476,427],[66111,44006,410],[63690,28074,742],[63690,28074,423],[63690,28035,231],[45481,18734,696],[64968,18802,696],[64831,16751,696],[62725,44567,696],[64902,30756,715],[65027,31131,715],[64902,9353,774],[65227,9786,774],[65985,15635,774],[66960,18776,774],[67176,32964,784],[66851,26195,262],[66030,32314,516],[65922,25166,516],[64947,13902,516],[19781,19642,429],[66896,18667,429],[67113,35889,429],[64947,42387,364],[65813,32098,364],[66896,23108,364],[66138,20942,364],[65922,11735,364],[66030,13902,224],[64838,17476,224],[67113,21917,224],[67113,23974,224],[66030,26791,224],[67221,40221,224],[66138,19101,148],[64838,11735,148],[62239,44445,115],[67330,13035,115],[19998,18776,61],[66030,30040,61],[66138,4587,494],[67330,41196,635],[67113,30040,635],[67113,20833,635],[67113,7728,744],[65922,6537,744],[65055,42171,852],[66355,41088,852],[65922,26791,852],[67005,13685,852],[65055,33939,949],[65922,21917,949],[64947,10869,971]]
  # speckles = [[12197, 17729, 884], [11738, 26289, 884], [11860, 30355, 884], [11830, 33625, 884], [10821, 38517, 884], [13644, 11643, 884], [11816, 11918, 756], [10522, 18922, 756], [10698, 22100, 756], [10816, 25513, 756], [11934, 33575, 756], [10875, 36341, 756], [10934, 40108, 756], [12169, 8741, 721], [27990, 8588, 686], [24730, 22754, 686], [37774, 17484, 686], [12018, 12083, 686], [10507, 18600, 686], [11640, 33477, 686], [10554, 39475, 686], [21605, 17514, 640], [43587, 6645, 640], [11130, 31353, 615], [12020, 16043, 615], [10655, 18205, 615], [11883, 8743, 615], [11003, 24200, 615], [23454, 10133, 615], [11996, 16372, 585], [11088, 19378, 585], [11259, 24285, 585], [11457, 27121, 585], [12223, 31772, 585], [11857, 31792, 535], [11009, 27198, 535], [10903, 17338, 535], [10974, 23982, 535], [12352, 8398, 535], [46457, 22664, 535], [12231, 9494, 453], [12987, 13980, 453], [11906, 16899, 453], [10933, 27710, 453], [11105, 35749, 453], [33717, 12461, 453], [11769, 33116, 399], [12341, 21958, 387], [10982, 17882, 387], [12055, 10944, 362], [13843, 12732, 362], [36802, 31185, 362], [12484, 14949, 330], [11125, 33330, 330], [13843, 6796, 255], [13486, 8870, 255], [11841, 20242, 255], [12055, 39410, 255], [10768, 33688, 255], [11698, 30827, 255], [11626, 28753, 255], [12913, 24819, 255], [13915, 10873, 255], [11912, 9728, 255], [13772, 6724, 164], [13915, 9371, 164], [14129, 11016, 164], [11984, 19956, 164], [12270, 22245, 164], [12055, 25105, 164], [11841, 28324, 164], [11841, 30613, 164], [10696, 33974, 164], [11841, 39410, 164], [39233, 4865, 113], [11841, 27251, 101], [11799, 37470, 90], [10791, 34887, 90], [10994, 39107, 90], [11665, 37236, 11], [10220, 35141, 11], [12099, 27484, 11], [11810, 12891, 11], [11087, 18454, 11], [11015, 32179, 11], [11160, 40415, 11]]

  with MockTaskQueue(queue_name='wms-test-pull-queue') as task_queue:
    # create_downsampling_tasks(task_queue, 'gs://neuroglancer/pinky40_v11/image/', mip=4)
  #   # create_downsampling_tasks(task_queue, dest_layer, mip=3)
  #   # create_downsampling_tasks(task_queue, 'gs://neuroglancer/s1_v0.1/image/', mip=0)

  #   create_quantized_affinity_tasks(task_queue,
  #     src_layer=src_layer,
  #     dest_layer=dest_layer,
  #     shape=shape,
  #   )

    create_transfer_tasks(task_queue,
      src_layer_path='s3://neuroglancer/pinky40_v11/watershed_mst_smc_sem5_remap/', 
      dest_layer_path='gs://neuroglancer/pinky40_v11/watershed_mst_smc_sem5_remap/',
    )

    

    # create_fixup_downsample_tasks(task_queue, 'gs://neuroglancer/pinky40_v11/image/', 
    #   points=points, mip=0) 

    # create_fixup_quantize_tasks(task_queue, src_layer, dest_layer, shape, 
    #   points=[ (27955, 21788, 512), (23232, 20703, 559) ],
    # )

  # create_fixup_quantize_tasks(task_queue, src_layer, dest_layer, shape, 
  #   points=[ (41740, 30477, 866) ]
  # )

  # task_queue.kill_threads()

  # with Storage('gs://neuroglancer/pinky40_v11/image') as stor:
  #   compute_build_bounding_box(stor, '4_4_40/')
        








    
