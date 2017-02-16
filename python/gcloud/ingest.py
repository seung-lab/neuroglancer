#!/usr/bin/python

"""Neuroglancer Cloud Ingest"""

import argparse
import json
import numpy as np
import h5py
import os
import sys
from itertools import product
from neuroglancer import chunks
from neuroglancer import downsample_scales
from google.cloud import storage
from tqdm import tqdm
import subprocess
import shutil
import random
import re

from CloudTask import CloudTask, TaskQueue

def mkdir(path):
    if not os.path.exists(path):
        os.makedirs(path)

    return path

GCLOUD_PROJECT = 'neuromancer-seung-import'
GCLOUD_QUEUE_NAME = 'test-pull-queue'
STAGING_DIR = mkdir('./staging/ingest/')

def generateInfo(filename, layer_type, resolution, should_mesh=False, chunk_size=64, num_channels=1):
  with h5py.File(filename, 'r') as f:
    img = f['main']
    volume_size = img.shape[::-1] 
    data_type = str(img.dtype)

  info = {
    "data_type": data_type,
    "num_channels": num_channels,
    "scales": [], 
    "type": layer_type,
  }

  if layer_type == "image":
    encoding = "jpeg"
  elif layer_type == "segmentation":
    encoding = "raw"
    if should_mesh:
      info['mesh'] = "mesh"

  scale_ratio = downsample_scales.compute_near_isotropic_downsampling_scales(
    size=volume_size,
    voxel_size=resolution,
    dimensions_to_downsample=[0, 1, 2],
    max_downsampling=float('inf')
  )

  for ratio in scale_ratio:
    downsampled_resolution = map(int, (np.array(resolution) * np.array(ratio)))
    scale = {  
      "chunk_sizes": [ [chunk_size, chunk_size, chunk_size] ],
      "encoding": encoding, 
      "key": "_".join(map(str, downsampled_resolution)),
      "resolution": downsampled_resolution,
      "size": map(int, np.ceil(np.array(volume_size) / ratio)),
      "voxel_offset": [0, 0, 0],
    }

    info["scales"].append(scale)

  return info

def slice_hdf5(filepath, layer):
  chunk_sizes = (256, 256, 64)

  sourcefile = h5py.File(filepath, 'r')
  
  sourceimage = sourcefile['main']
  volume_size = sourceimage.shape[::-1] 
  data_type = str(sourceimage.dtype)

  # Step through coordinate space from 0 to volume_size
  # using steps of chunk_sizes (e.g. 1024 in x,y and 128 in z)

  rangeargs = ( (0, vs, cs) for vs, cs in zip(volume_size, chunk_sizes) )
  xyzranges = [ xrange(beg, end, step) for beg, end, step in rangeargs ]

  every_xyz = product(*xyzranges)

  savedir = mkdir(os.path.join(STAGING_DIR, layer))

  sliced_filenames = []

  for x,y,z in tqdm(every_xyz):
    xyz = (x,y,z)
    x_end, y_end, z_end = ( min(xyz[i] + chunk_sizes[i], volume_size[i]) for i in xrange(3) )

    chunkimg = sourceimage[ z : z_end, y : y_end, x : x_end ]
    npz = chunks.encode_npz(chunkimg)

    chunk_file_name = "{}-{}_{}-{}_{}-{}.npz".format(x, x_end, y, y_end, z, z_end)

    chunk_file_path = os.path.join(savedir, chunk_file_name)

    with open(chunk_file_path, 'w') as chunkfile:
      chunkfile.write(npz)

    sliced_filenames.append(chunk_file_path)

  sourcefile.close()

  return sliced_filenames

def upload_info(info, cloudpath):
  cloudpath = format_cloudpath(cloudpath) # bucket/dataset/layer
  
  parts = cloudpath.split('/') # [ bucket, dataset, layer ]

  bucket_name = parts[0]

  parts.append('info')
  url = "/".join(parts[1:]) # dataset/layer/info

  client = storage.Client(project=GCLOUD_PROJECT)
  bucket = client.get_bucket(bucket_name)

  print("Uploading Info")
  blob = storage.blob.Blob(url, bucket)
  blob.upload_from_string(json.dumps(info))
  blob.make_public()

def format_cloudpath(cloudpath):
  """convert gc://bucket/dataset/layer or /bucket/dataset/layer
                bucket/dataset/layer/
     to: bucket/dataset/layer """

  cloudpath = re.sub(r'^(gc:)?\/+', '', cloudpath)
  cloudpath = re.sub(r'\/+$', '', cloudpath)
  return cloudpath

def upload_slices(filenames, cloudpath):
  
  cloudpath = format_cloudpath(cloudpath)

  # gsutil chokes when you ask it to upload more than about 1500 files at once
  # so we're using streaming mode (-I) to enable it to handle arbitrary numbers of files
  # -m = multithreaded upload, -h = headers

  gsutil_upload_cmd = "gsutil -m -h 'Content-Type:application/octet-stream' cp -I -a public-read gs://{cloudpath}/build/".format(
    cloudpath=cloudpath
  )

  gcs_pipe = subprocess.Popen([gsutil_upload_cmd], 
    stdin=subprocess.PIPE, 
    stdout=sys.stdout, 
    shell=True
  )

  # shoves filenames into pipe stdin, waits for process to execute, and terminates
  # returns stdout
  gcs_pipe.communicate(input="\n".join(filenames))


def populate_cloud_tasks(filenames, cloudpath, queuename):
  cloudpath = format_cloudpath(cloudpath)

  taskqueue = TaskQueue(GCLOUD_PROJECT, queuename)

  for fname in filenames:
    task = CloudTask()
    task.chunk_path = os.path.join(cloudpath, '/build/', fname)
    task.chunk_encoding = 'npz'
    task.info_path = os.path.join(cloudpath, '/info')
    taskqueue.insert(t)

if __name__ == '__main__':
  parser = argparse.ArgumentParser(description='Ingest hdf5 dataset into GCloud and initiate process into neuroglancer format.')
  parser.add_argument('--channel', dest='channel_path', action='store',
    default=None, metavar='IMAGE_FILE_PATH',
    help='Filepath to channel image stack hdf5 (use this xor --segmentation)')

  parser.add_argument('--segmentation', dest='segmentation_path', action='store',
    default=None, metavar='IMAGE_FILE_PATH',
    help='Filepath to segmentation hdf5 (use this xor --channel)')

  parser.add_argument('--mesh', dest='should_mesh', action='store_true', default=False,
    help='Generate meshes based on the segmentation. Used in combination with --segmentation flag.')
                  
  parser.add_argument('--cloudpath', 
    dest='cloudpath', action='store', metavar='CLOUD_PATH',
    help='/[BUCKET]/[DATASET]/[LAYER] Path to gcloud bucket layer. e.g. /neuroglancer/snemi3d/images ; e.g. /neuroglancer/golden_cube_3x3/segmentation', 
    required=True)

  parser.add_argument('--resolution', dest='resolution', action='store',
                              metavar='X,Y,Z',
                help='X,Y,Z comma seperated anisotropy. e.g. 6,6,30 meaning 6nm x 6nm x 30nm', required=True)  

  args = parser.parse_args()

  resolution = map(int, args.resolution.split(','))

  has_channel = args.channel_path is not None
  has_segmentation = args.segmentation_path is not None

  if has_channel == has_segmentation:
    raise Exception("You must specify --channel xor --segmentation. -h for help.")

  filename = args.channel_path or args.segmentation_path

  layer = args.cloudpath.split('/')[-1]
  layer_type = (has_channel and 'image') or (has_segmentation and 'segmentation')

  info = generateInfo(
    filename=filename,
    layer_type=layer_type, 
    resolution=resolution, 
    should_mesh=args.should_mesh,
  )

  upload_info(info, args.cloudpath)

  filenames = slice_hdf5(filename, layer)
  upload_slices(filenames, args.cloudpath)
  populate_cloud_tasks(filenames, args.cloudpath, GCLOUD_QUEUE_NAME)
  










