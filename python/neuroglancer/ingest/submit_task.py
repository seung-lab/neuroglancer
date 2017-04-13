from __future__ import print_function
import json
import math
import re
from itertools import product
import copy

import numpy as np
from tqdm import tqdm

import neuroglancer.ingest.lib as lib
from neuroglancer.ingest.lib import xyzrange, Vec, Bbox, min2, max2, Storage
from neuroglancer import downsample_scales, chunks
from neuroglancer.ingest.tasks import (TaskQueue, BigArrayTask, IngestTask, IngestS1Task,
   HyperSquareTask, MeshTask, MeshManifestTask, DownsampleTask)
from neuroglancer.ingest.volumes import HDF5Volume, GCloudVolume

def create_ingest_tasks(dataset_name, layer_name):
  """
  Creates one task for each ingest chunk present in the build folder.
  It is required that the info file is already placed in order for this task
  to run succesfully.
  """
  tq = TaskQueue()
  bucket = lib.get_bucket(use_secrets=False)
  blobs = bucket.list_blobs(prefix='{}/{}/build/'.format(dataset_name, layer_name))
  for blob in tqdm(blobs, desc="Inserting Ingest Tasks"):
    t = IngestTask(
      chunk_path='gs://neuroglancer/'+blob.name,
      chunk_encoding='npz',
      info_path='gs://neuroglancer/{}/{}/info'.format(dataset_name,layer_name),
    )
    t.execute()
    # tq.insert(t)

def create_s1_ingest_tasks(dataset_name, layer_name):
  """
  Creates one task for each ingest chunk present in the build folder.
  It is required that the info file is already placed in order for this task
  to run succesfully.

  s1 was an early build so it has some weird attributes like 1px overlaps.
  """
  tq = TaskQueue()
  bucket = lib.get_bucket(use_secrets=False)
  blobs = bucket.list_blobs(prefix='{}/{}/build/'.format(dataset_name, layer_name))
  for blob in tqdm(blobs, desc="Inserting Ingest Tasks"):
    t = IngestS1Task(
      chunk_path='gs://neuroglancer/'+blob.name,
      chunk_encoding='npz',
      info_path='gs://neuroglancer/{}/{}/info'.format(dataset_name,layer_name),
    )
    # t.execute()
    tq.insert(t)

def create_downsampling_tasks(dataset_name, layer_name, mip=-1, shape=Vec(2048, 2048, 64)):
  vol = GCloudVolume(dataset_name, layer_name, mip)
  
  shape = min2(vol.volume_size, shape)
  scales = downsample_scales.compute_xy_plane_downsampling_scales(shape)[1:] # omit (1,1,1)
  scales = [ vol.downsample_ratio * Vec(*factor3) for factor3 in scales ]
  map(vol.addScale, scales)
  vol.commitInfo()

  tq = TaskQueue()
  for startpt in tqdm(xyzrange( vol.bounds.minpt, vol.bounds.maxpt, shape ), desc="Inserting Downsample Tasks"):
    task = DownsampleTask(
      dataset_name=vol.dataset_name,
      layer=vol.layer,
      mip=vol.mip,
      shape=shape.clone(),
      offset=startpt.clone(),
    )
    task.execute()
    # tq.insert(task)

def create_fixup_downsample_tasks(dataset_name, layer_name, points):
  """you can use this to fix black spots from when downsample tasks fail
  by specifying a point inside each black spot.
  """
  pts = map(np.array, points)

  shape = Vec(2048, 2048, 64)

  def nearest_offset(pt):
    return np.floor(pt / shape) * shape

  offsets = map(nearest_offset, pts)

  tq = TaskQueue()
  for offset in tqdm(offsets, desc="Inserting Corrective Downsample Tasks"):
    task = DownsampleTask(
      dataset_name=dataset_name,
      layer=layer_name,
      mip=0,
      shape=shape,
      offset=offset,
    )
    task.execute()
    # tq.insert(task)


def create_bigarray_task(dataset_name, layer_name):
  """
  Creates one task for each bigarray chunk present in the bigarray folder.
  These tasks will convert the bigarray chunks into chunks that ingest tasks are able to understand.
  """
  tq = TaskQueue()
  bucket = lib.get_bucket(use_secrets=True)
  blobs = bucket.list_blobs(prefix='{}/{}/bigarray/'.format(dataset_name, layer_name))
  for blob in tqdm(blobs, desc="Inserting BigArray Tasks"):
    name = blob.name.split('/')[-1]
    if name == 'config.json':
      continue       
    t = BigArrayTask(
      chunk_path='gs://neuroglancer/'+blob.name,
      chunk_encoding='npz_uint8', #_uint8 for affinites
      version='{}/{}'.format(dataset_name,layer_name))
    tq.insert(t)

def compute_bigarray_bounding_box(dataset_name, layer_name):
  """
  There are many versions of bigarray which have subtle differences.
  Given that it is unlikely that we are migrating from the bigarray format to the
  precomputed chunks once, it is unlikely that we will use these methods in the future.
  We decided to write the shape and offset for each 'version' in tasks.py which can
  be computed using this function.
  """
  
  bucket = lib.get_bucket(use_secrets=True)
  bboxes = []
  blobs = bucket.list_blobs(prefix='{}/{}/bigarray/'.format(dataset_name, layer_name))
  for blob in tqdm(blobs, desc="Computing BigArray Bounds"):
    name = blob.name.split('/')[-1]
    if name == 'config.json':
      continue
    
    bboxes.append( Bbox.from_filename(blob.name) )

  bounds = Bbox.expand(*bboxes)

  print('shape', bounds.size3() + 1)
  print('offset', bounds.minpt - 1)

def compute_build_bounding_box(dataset_name, layer_name):
  bboxes = []

  bucket = lib.get_bucket(use_secrets=True)
  blobs = bucket.list_blobs(prefix='{}/{}/build/'.format(dataset_name, layer_name))
  for blob in tqdm(blobs, desc="Computing Build Bounds"):
    bbox = Bbox.from_filename(blob.name) 
    bboxes.append(bbox)

  bounds = Bbox.expand(*bboxes)
  chunk_size = reduce(max2, map(lambda bbox: bbox.size3(), bboxes))

  print('bounds={} (size: {}); chunk_size={}'.format(bounds, bounds.size3(), chunk_size))
  
  return bounds, chunk_size

def get_build_data_type_and_shape(dataset_name, layer_name):
  bucket = lib.get_bucket(use_secrets=True)
  blobs = bucket.list_blobs(prefix='{}/{}/build/'.format(dataset_name, layer_name))
  for blob in blobs:
    arr = chunks.decode_npz(blob.download_as_string())
    return arr.dtype.name, arr.shape[3] #num_channels

def create_info_file_from_build(dataset_name, layer_name, layer_type, encoding, resolution):
  assert layer_type == "image" or layer_type == "segmentation"
  bounds, build_chunk_size = compute_build_bounding_box(dataset_name, layer_name)
  data_type, num_channels = get_build_data_type_and_shape(dataset_name, layer_name)

  neuroglancer_chunk_size = find_closest_divisor(build_chunk_size, closest_to=[64,64,64])

  info = GCloudVolume.create_new_info(
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

  scale_ratios = downsample_scales.compute_xy_plane_downsampling_scales(
    size=build_chunk_size,
    max_downsampled_size=max(neuroglancer_chunk_size[:2]), # exclude z since it won't be downsampled
  )

  vol = GCloudVolume(dataset_name, layer_name, mip=0, info=info, use_secrets=True)
  map(vol.addScale, scale_ratios)

  vol.commitInfo()

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


def create_hypersquare_ingest_tasks(hypersquare_bucket_name, dataset_name, hypersquare_chunk_size, resolution, voxel_offset, volume_size, overlap):
  def crtinfo(layer_type, dtype, encoding):
    return GCloudVolume.create_new_info(
      num_channels=1,
      layer_type=layer_type,
      data_type=dtype,
      encoding=encoding,
      resolution=resolution,
      voxel_offset=voxel_offset,
      volume_size=volume_size,
    )

  imginfo = crtinfo('image', 'uint8', 'jpeg')
  seginfo = crtinfo('segmentation', 'uint16', 'raw')

  scales = downsample_scales.compute_xy_plane_downsampling_scales(hypersquare_chunk_size)[1:] # omit (1,1,1)

  imgvol = GCloudVolume(dataset_name, 'image', 0, info=imginfo)
  segvol = GCloudVolume(dataset_name, 'segmentation', 0, info=seginfo)

  print("Creating info files for image and segmentation...")
  imgvol.commitInfo()
  segvol.commitInfo()

  world_bounds = lib.Bbox( voxel_offset, Vec(*voxel_offset) + Vec(*volume_size) )

  def crttask(volname, tasktype):
    return HyperSquareTask(
      bucket_name=hypersquare_bucket_name,
      dataset_name=dataset_name,
      layer_name=tasktype,
      volume_dir=volname,
      layer_type=tasktype,
      overlap=overlap,
      world_bounds=world_bounds,
      resolution=resolution,
    )

  tq = TaskQueue()
  print("Listing hypersquare bucket...")
  # volumes_listing = lib.gcloud_ls('gs://{}/'.format(hypersquare_bucket_name))

  with open('e2198_volumes.json', 'r') as f:
    volumes_listing = json.loads(f.read())

  volumes_listing = [ x.split('/')[-2] for x in volumes_listing ]

  for cloudpath in tqdm(volumes_listing, desc="Creating Ingest Tasks"):
    # print(cloudpath)
    task = crttask(cloudpath, 'image')
    # task.execute()
    tq.insert(task)
    # tq.insert( crttask(cloudpath, 'segmentation') )


def upload_build_chunks(dataset_name, layer_name, volume, offset=[0, 0, 0], build_chunk_size=[1024,1024,128]):
  storage = Storage(dataset_name=dataset_name, layer_name=layer_name, compress=False)
  xyzranges = ( xrange(0, vs, bcs) for vs, bcs in zip(volume.shape, build_chunk_size) )
  for x_min, y_min, z_min in tqdm(product(*xyzranges)):
    x_max = min(volume.shape[0], x_min + build_chunk_size[0])
    y_max = min(volume.shape[1], y_min + build_chunk_size[1])
    z_max = min(volume.shape[2], z_min + build_chunk_size[2])
    chunk = volume[x_min:x_max, y_min:y_max, z_min:z_max]

    # adds offsets
    x_min += offset[0]; x_max += offset[0]
    y_min += offset[1]; y_max += offset[1]
    z_min += offset[2]; z_max += offset[2]
    filename = "{}-{}_{}-{}_{}-{}".format(
      x_min, x_max, y_min, y_max, z_min, z_max)
    storage.add_file(filename, chunks.encode_npz(chunk))
  storage.flush('build/')

def ingest_hdf5_example():
  dataset_name = "snemi3d_v0"
  offset = [0,0,0]
  resolution=[6,6,30]
  # ingest image
  layer_name = "image"
  layer_type = "image"
  volume =  HDF5Volume('/usr/people/it2/snemi3d/image.h5', layer_type)
  upload_build_chunks(dataset_name, layer_name, volume, offset)
  create_info_file_from_build(dataset_name, layer_name, layer_type, resolution=resolution, encoding="jpeg")
  create_ingest_task(dataset_name, layer_name)
  create_downsampling_tasks("snemi3d_v0","image")

  # ingest segmentation
  layer_name = "segmentation"
  layer_type = "segmentation"
  volume =  HDF5Volume('/usr/people/it2/snemi3d/human_labels.h5', layer_type)
  upload_build_chunks(dataset_name, layer_name, volume, offset)
  create_info_file_from_build(dataset_name, layer_name, layer_type, resolution=resolution, encoding="raw")
  create_ingest_task(dataset_name, layer_name)
  create_downsampling_tasks("snemi3d_v0","segmentation")
  MeshTask(chunk_key="gs://neuroglancer/snemi3d_v0/segmentation/6_6_30",
       chunk_position="0-1024_0-1024_0-51",
       info_path="gs://neuroglancer/snemi3d_v0/segmentation/info", 
       lod=0, simplification=5, segments=[]).execute()
  MeshTask(chunk_key="gs://neuroglancer/snemi3d_v0/segmentation/6_6_30",
       chunk_position="0-1024_0-1024_50-100",
       info_path="gs://neuroglancer/snemi3d_v0/segmentation/info", 
       lod=0, simplification=5, segments=[]).execute()
  MeshManifestTask(info_path="gs://neuroglancer/snemi3d_v0/segmentation/info",
           lod=0).execute()

  # ingest affinities
  #   HDF5Volume does some type convertion when affinities are specified as layer type
  #   but neuroglancer only has image or segmentation layer types
  layer_name = "affinities"
  layer_type = "image"
  volume =  HDF5Volume('/usr/people/it2/snemi3d/affinities.h5', layer_type='affinities') 
  upload_build_chunks(dataset_name, layer_name, volume, offset)
  create_info_file_from_build(dataset_name, layer_name, layer_type, resolution=resolution, encoding="raw")
  create_ingest_task(dataset_name, layer_name)
  create_downsampling_tasks(dataset_name,"segmentation")
  MeshTask(chunk_key="gs://neuroglancer/"+dataset_name+"/segmentation/6_6_30",
           chunk_position="0-1024_0-1024_0-51",
           info_path="gs://neuroglancer/"+dataset_name+"/segmentation/info",
           lod=0, simplification=5, segments=[]).execute()
  MeshTask(chunk_key="gs://neuroglancer/"+dataset_name+"/segmentation/6_6_30",
           chunk_position="0-1024_0-1024_50-100",
           info_path="gs://neuroglancer/"+dataset_name+"/segmentation/info",
           lod=0, simplification=5, segments=[]).execute()
  MeshManifestTask(info_path="gs://neuroglancer/"+dataset_name+"/segmentation/info",
                   lod=0).execute()

  create_downsampling_tasks("snemi3d_v0","affinities")

  
if __name__ == '__main__':   
  
  # select 
  #     min(xmin), min(ymin), min(zmin), 
  #     max(xmax), max(ymax), max(zmax), 
  #     max(xmax) - min(xmin) shapex, 
  #     max(ymax) - min(ymin) shapey, 
  #     max(zmax) - min(zmin) shapez 
  # from volumes where dataset=1;

  create_hypersquare_ingest_tasks('e2198_compressed', 'e2198_v0', 
    hypersquare_chunk_size=[ 256, 256, 256 ], 
    resolution=[ 17, 17, 23 ], 
    voxel_offset=[ 466, 498, 434 ], # from n017 SQL query
    volume_size=[ 3840, 20192, 12352 ], # from n017 SQL query
    overlap=[ 32, 32, 32 ],
  )

  # create_ingest_tasks('e2198_v0', 'image')

  # create_downsampling_tasks('s1_v0.1', 'image', mip=4)
  # create_fixup_downsample_tasks('s1_v0.1', 'image', [ (4434, 4518, 873) ])

  # create_info_file_from_build('s1_v0.1', layer_name='image', layer_type='image', resolution=[6,6,30], encoding='jpeg')
  # create_s1_ingest_tasks('s1_v0.1', 'image')



  # create_hypersquare_tasks("zfish_v0","segmentation", "zfish", "all_7/hypersquare/")
  # create_info_file_from_build(dataset_name="zfish_v0",
  #                             layer_name="segmentation",
  #                             layer_type="segmentation",
  #                             resolution=[5,5,45])
  # create_ingest_task("zfish_v0","segmentation")

  # create_hypersquare_tasks("e2198_v0","image","e2198_compressed","")
  # create_info_file_from_build(dataset_name="e2198_v0",
  #                             layer_name="image",
  #                             layer_type="image",
  #                             resolution=[17,17,23])
  # create_ingest_tasks("e2198_v0","image")
  pass
