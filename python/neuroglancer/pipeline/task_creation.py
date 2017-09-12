from __future__ import print_function
import copy
from itertools import product
import json
import math
import re
import os

import numpy as np
from tqdm import tqdm
from cloudvolume import CloudVolume, Storage
from cloudvolume.lib import Vec, Bbox, max2, min2, xyzrange, find_closest_divisor

from neuroglancer import downsample_scales, chunks
from neuroglancer.pipeline import TaskQueue, MockTaskQueue
from neuroglancer.pipeline.tasks import (
  BigArrayTask, IngestTask, HyperSquareTask, HyperSquareConsensusTask, 
  MeshTask, MeshManifestTask, DownsampleTask, QuantizeAffinitiesTask, 
  TransferTask, WatershedRemapTask
)
from neuroglancer.pipeline.volumes import HDF5Volume

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
        arr = chunks.decode_npz(storage.get_file(filename))
        return arr.dtype.name, arr.shape[3] #num_channels

def create_info_file_from_build(layer_path, layer_type, resolution, encoding):
  assert layer_type in ('image', 'segmentation', 'affinities')

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

  vol = CloudVolume(layer_path, mip=0, info=info).commitInfo()
  vol = create_downsample_scales(layer_path, mip=0, ds_shape=build_chunk_size, axis='z')
  
  return vol.info

def create_downsample_scales(layer_path, mip, ds_shape, axis='z'):
  vol = CloudVolume(layer_path, mip)
  shape = min2(vol.volume_size, ds_shape)

  # sometimes we downsample a base layer of 512x512 
  # into underlying chunks of 64x64 which permits more scales
  underlying_mip = (mip + 1) if (mip + 1) in vol.available_mips else mip
  underlying_shape = vol.mip_underlying(underlying_mip).astype(np.float32)

  toidx = { 'x': 0, 'y': 1, 'z': 2 }
  preserved_idx = toidx[axis]
  underlying_shape[preserved_idx] = float('inf')

  scales = downsample_scales.compute_plane_downsampling_scales(
    size=shape, 
    preserve_axis=axis, 
    max_downsampled_size=int(min(*underlying_shape)),
  )
  scales = scales[1:] # omit (1,1,1)
  scales = [ vol.downsample_ratio * Vec(*factor3) for factor3 in scales ]
  map(vol.add_scale, scales)
  return vol.commitInfo()

def create_downsampling_tasks(task_queue, layer_path, mip=-1, fill_missing=False, axis='z', num_mips=5):
  shape = (64 * (2 ** num_mips), 64 * (2 ** num_mips), 64)
  vol = create_downsample_scales(layer_path, mip, shape)
  shape = vol.underlying[:3]
  shape.x *= 2 ** num_mips
  shape.y *= 2 ** num_mips

  for startpt in tqdm(xyzrange( vol.bounds.minpt, vol.bounds.maxpt, shape ), desc="Inserting Downsample Tasks"):
    task = DownsampleTask(
      layer_path=layer_path,
      mip=vol.mip,
      shape=shape.clone(),
      offset=startpt.clone(),
      axis=axis,
      fill_missing=fill_missing,
    )
    task_queue.insert(task)
  task_queue.wait()

def create_meshing_tasks(task_queue, layer_path, mip, shape=Vec(512, 512, 512)):
  shape = Vec(*shape)
  vol = CloudVolume(layer_path, mip)

  for startpt in tqdm(xyzrange( vol.bounds.minpt, vol.bounds.maxpt, shape ), desc="Inserting Mesh Tasks"):
    task = MeshTask(
      layer_path=layer_path,
      mip=vol.mip,
      shape=shape.clone(),
      offset=startpt.clone(),
      max_simplification_error=40,
    )
    task_queue.insert(task)
  task_queue.wait()

def create_transfer_tasks(task_queue, src_layer_path, dest_layer_path, shape=Vec(2048, 2048, 64), skip_downsample=False, fill_missing=False):
  shape = Vec(*shape)
  vol = CloudVolume(src_layer_path)

  if not skip_downsample:
    create_downsample_scales(dest_layer_path, mip=0, ds_shape=shape)

  for startpt in tqdm(xyzrange( bounds.minpt, bounds.maxpt, shape ), desc="Inserting Transfer Tasks"):
    task = TransferTask(
      src_path=src_layer_path,
      dest_path=dest_layer_path,
      shape=shape.clone(),
      offset=startpt.clone(),
      skip_downsample=skip_downsample,
      fill_missing=fill_missing,
    )
    task_queue.insert(task)
  task_queue.wait()

def create_watershed_remap_tasks(task_queue, map_path, src_layer_path, dest_layer_path, shape=Vec(2048, 2048, 64)):
  shape = Vec(*shape)
  vol = CloudVolume(src_layer_path)

  create_downsample_scales(dest_layer_path, mip=0, ds_shape=shape)

  for startpt in tqdm(xyzrange( vol.bounds.minpt, vol.bounds.maxpt, shape ), desc="Inserting Remap Tasks"):
    task = WatershedRemapTask(
      map_path=map_path,
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
    mip0offset = (np.floor((pt - vol.mip_voxel_offset(0)) / shape) * shape) + vol.mip_voxel_offset(0)
    return mip0offset / vol.downsample_ratio

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

def create_quantized_affinity_tasks(taskqueue, src_layer, dest_layer, shape, fill_missing=False):
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
      fill_missing=fill_missing,
    )
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

# split the work up into ~1000 tasks (magnitude 3)
def create_mesh_manifest_tasks(task_queue, layer_path, magnitude=3):
  assert int(magnitude) == magnitude

  start = 10 ** (magnitude - 1)
  end = 10 ** magnitude

  # For a prefix like 100, tasks 1-99 will be missed. Account for them by
  # enumerating them individually with a suffixed ':' to limit matches to
  # only those small numbers
  for prefix in xrange(1, start):
    task = MeshManifestTask(layer_path=layer_path, prefix=str(prefix) + ':')
    task_queue.insert(task)

  # enumerate from e.g. 100 to 999
  for prefix in xrange(start, end):
    task = MeshManifestTask(layer_path=layer_path, prefix=prefix)
    task_queue.insert(task)

  task_queue.wait()

def create_hypersquare_ingest_tasks(task_queue, hypersquare_bucket_name, dataset_name, hypersquare_chunk_size, resolution, voxel_offset, volume_size, overlap):
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

  def crttask(volname, tasktype, layer_name):
    return HyperSquareTask(
      bucket_name=hypersquare_bucket_name,
      dataset_name=dataset_name,
      layer_name=layer_name,
      volume_dir=volname,
      layer_type=tasktype,
      overlap=overlap,
      resolution=resolution,
    )

  print("Listing hypersquare bucket...")
  volumes_listing = lib.gcloud_ls('gs://{}/'.format(hypersquare_bucket_name))

  # download this from: 
  # with open('e2198_volumes.json', 'r') as f:
  #   volumes_listing = json.loads(f.read())

  volumes_listing = [ x.split('/')[-2] for x in volumes_listing ]

  for cloudpath in tqdm(volumes_listing, desc="Creating Ingest Tasks"):
    # print(cloudpath)
    # img_task = crttask(cloudpath, 'image', IMG_LAYER_NAME)
    seg_task = crttask(cloudpath, 'segmentation', SEG_LAYER_NAME)
    # seg_task.execute()
    tq.insert(seg_task)

def create_hypersquare_consensus_tasks(task_queue, src_path, dest_path, volume_map_file, consensus_map_path, shape):
  """
  Transfer an Eyewire consensus into neuroglancer. This first requires
  importing the raw segmentation via a hypersquare ingest task. However,
  this can probably be streamlined at some point.

  The volume map file should be JSON encoded and 
  look like { "X-X_Y-Y_Z-Z": EW_VOLUME_ID }

  The consensus map file should look like:
  { VOLUMEID: { CELLID: [segids] } }
  """

  with open(volume_map_file, 'r') as f:
    volume_map = json.loads(f.read())

  create_downsample_scales(dest_path, mip=0, ds_shape=shape)

  for boundstr, volume_id in tqdm(volume_map.iteritems(), desc="Inserting HyperSquare Consensus Remap Tasks"):
    bbox = Bbox.from_filename(boundstr)

    task = HyperSquareConsensusTask(
      src_path=src_path,
      dest_path=dest_path,
      ew_volume_id=int(volume_id),
      consensus_map_path=consensus_map_path,
      shape=bbox.size3(),
      offset=bbox.minpt.clone(),
    )
    task_queue.insert(task)
  task_queue.wait()

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

  src_path = 'gs://neuroglancer/pinky40_v11/watershed/'
  dest_path = 'gs://neuroglancer/pinky40_v11/watershed_mst_split_tuning_remap/' 
  map_path = os.path.join(dest_path, 'mst_split_tuning_remap.npy')
  
  with MockTaskQueue(queue_name='wms-pull-queue', queue_server='pull-queue') as task_queue:
    # create_downsampling_tasks(task_queue, 'gs://neuroglancer/zfish_v0/consensus-2017-07-11/', mip=5, fill_missing=True)
    # create_meshing_tasks(task_queue, src_path, mip=3)

    # create_mesh_manifest_tasks(task_queue, dest_path)

    # create_watershed_remap_tasks(task_queue, map_path, src_path, dest_path)

    # create_hypersquare_consensus_tasks(task_queue,
    #   src_path='gs://neuroglancer/zfish_v0/segmentation/',
    #   dest_path='gs://neuroglancer/zfish_v0/consensus-2017-07-11',
    #   volume_map_file='/Users/wms/Desktop/zfish_volumes.json',
    #   consensus_map_path='gs://neuroglancer/zfish_v0/consensus-2017-07-11/zfish_consensus.json',
    #   shape=(896, 896, 56),
    # )

    # create_quantized_affinity_tasks(task_queue,
    #   src_layer='gs://neuroglancer/zfish_v1/affinitymap',
    #   dest_layer='gs://neuroglancer/zfish_v1/qaffinitymap-x',
    #   shape=(2048, 2048, 64),
    #   fill_missing=True,
    # )

    create_transfer_tasks(task_queue,
      src_layer_path='gs://neuroglancer/pinky40_v11/psdsegs_mst_smc/', 
      dest_layer_path='boss://pinky40/v7/psdsegs_mst_smc_2_ingest_2',
      shape=(1024,1024,64),
      skip_downsample=True,
      fill_missing=True,
    )


    # create_fixup_downsample_tasks(task_queue, 'gs://neuroglancer/pinky40_v11/image/', 
    #   points=[ (66098, 13846, 139) ], mip=5, shape=(128,128,64)) 

    # create_fixup_quantize_tasks(task_queue, src_layer, dest_layer, shape, 
    #   points=[ (27955, 21788, 512), (23232, 20703, 559) ],
    # )

  # create_fixup_quantize_tasks(task_queue, src_layer, dest_layer, shape, 
  #   points=[ (41740, 30477, 866) ]
  # )

  # task_queue.kill_threads()

  # with Storage('gs://neuroglancer/pinky40_v11/image') as stor:
  #   compute_build_bounding_box(stor, '4_4_40/')