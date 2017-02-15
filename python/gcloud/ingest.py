#!/usr/bin/python

"""Neuroglancer Cloud Ingest 


"""

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

def mkdir(path):
    if not os.path.exists(path):
        os.makedirs(path)

    return path

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

    chunkimg = sourceimage[ z : z_end ][ y : y_end ][ x : x_end ]

    chunk_file_name = "{}-{}_{}-{}_{}-{}.h5".format(x, x_end, y, y_end, z, z_end)

    chunk_file_path = os.path.join(savedir, chunk_file_name)

    with h5py.File(chunk_file_path, 'w') as chunkfile:
      chunkfile['main'] = chunkimg

    sliced_filenames.append(chunk_file_path)

  sourcefile.close()

  return sliced_filenames

def upload_info(info, cloudpath):
  cloudpath = format_cloudpath(cloudpath) # bucket/dataset/layer
  
  parts = cloudpath.split('/') # [ bucket, dataset, layer ]

  bucket_name = parts[0]

  parts.append('info')
  url = "/".join(parts[1:]) # dataset/layer/info

  client = storage.Client(project='neuromancer-seung-import')
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

def upload_hdf5_slices(filenames, cloudpath):
  
  cloudpath = format_cloudpath(cloudpath)

  gsutil_upload_cmd = "gsutil -m -h 'Content-Type:application/x-hdf' cp -I -Z -a public-read gs://{cloudpath}/ingest/".format(
    cloudpath=cloudpath
  )

  gcs_pipe = subprocess.Popen([gsutil_upload_cmd], 
    stdin=subprocess.PIPE, 
    stdout=sys.stdout, 
    shell=True
  )

  # # process files stride files at a time
  # stride = 2
  # size = len(filenames)
  # slice_end = lambda i: min(size, (i+stride))
  # filename_generator = ( filenames[ j:slice_end(j) ] for j in xrange(0, size, stride) )

  try:
    for filename in filenames:
      gcs_pipe.write(filename)
  finally:
    gcs_pipe.flush()
    gcs_pipe.terminate()


def populate_cloud_task_queue():
  pass

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
    help='/[DATASET]/[BUCKET]/[LAYER] Path to gcloud bucket layer. e.g. /neuroglancer/snemi3d/images ; e.g. /neuroglancer/golden_cube_3x3/segmentation', 
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

  upload_hdf5_slices(slice_hdf5(filename, layer), args.cloudpath)

 

  #ingest --segmentation ../machine_labels.h5 --mesh --cloudpath /neuroglancer/snemi3d/corrected_images/ --resolution 6,6,30
  










