#!/usr/bin/python

from __future__ import print_function
import argparse
import h5py
import numpy as np
import os
import sys
import signal
from mesher import Mesher
import subprocess
import json
import math
import shutil
from tqdm import tqdm
from collections import defaultdict
from time import time
import tempfile

VERBOSE = True

def vprint(*args, **kwargs):
  if VERBOSE:
    print(*args, **kwargs)

def mkdir(path):
    if not os.path.exists(path):
        os.makedirs(path)

    return path

STAGING_DIR = mkdir(os.environ['HOME'] + '/neuroglancer/python/gcloud/staging/meshes/')
MESH_DIR = tempfile.mkdtemp(dir=STAGING_DIR)
OBJ_DIR = os.path.join(STAGING_DIR, 'obj')
MANIFESTS_DIR = os.path.join(STAGING_DIR, 'manifests')
JSON_DIR = os.path.join(STAGING_DIR, 'json')

FILES_PER_SUBDIR = 300

EPSILON = sys.float_info.epsilon

performance = [ EPSILON for i in range(300) ]

signal.signal(signal.SIGTERM, lambda: shutil.rmtree(MESH_DIR))

def progress(obj_id, count, N):
    items = min(len(performance), count)
    persec = float(items) / sum(performance) 

    vprint("writing {}\t({}/{}, {:0.2f}/sec) ...\r".format(obj_id, count, N, persec), end="")
    sys.stdout.flush()

def mesh_path(i):
    return os.path.join(MESH_DIR, str(i))

def json_path(i):
    return os.path.join(STAGING_DIR, 'json', str(int(i)))

def mesh_volume(labels_file):
    mesher = Mesher()

    with h5py.File(labels_file) as f:
      arr = f['main'][:]
      vprint("meshing...")
      mesher.mesh(arr.flatten(), *arr.shape)

    return mesher

def scaled_points(points, resolution):
    # zlib meshing multiplies verticies by two to avoid working with floats like 1.5
    # but we need to recover the exact position for display
    points /= 2.0 

    points[0::3] *= resolution[0] 
    points[1::3] *= resolution[1] 
    points[2::3] *= resolution[2] 

    return points

def generate_objs(mesher, resolution):
  mkdir(OBJ_DIR)

  vprint("generating obj mesh files...")
  for obj_id in tqdm(mesher.ids()):
    mesher.write_obj(obj_id, OBJ_DIR + str(obj_id) + '.obj')

def create_vbo(mesher, obj_id):
  mesh = mesher.get_mesh(obj_id, simplification_factor=100)

  numpoints = len(mesh['points']) / 3
  numindicies = len(mesh['faces'])

  points = np.array(mesh['points'], dtype=np.float32)
  scalepoints = scaled_points(points, resolution) 

  vertex_index_format = [
    np.array([ numpoints ], dtype=np.uint32),
    np.array(scalepoints, dtype=np.float32),
    np.array(mesh['faces'], dtype=np.uint32)
  ]

  return b''.join([ array.tobytes() for array in vertex_index_format ])

def generate_vbos(mesher, resolution, chunk_name):
  mkdir(STAGING_DIR)
  mkdir(MANIFESTS_DIR)

  manifest = os.path.join(MANIFESTS_DIR, chunk_name + '.json')

  with open(manifest, 'w') as f:
    f.write(json.dumps(mesher.ids()))

  current_dir_index = 0

  vprint("generating VBO fragments and metadata json...")
  for count, obj_id in enumerate(mesher.ids()):
    if count % FILES_PER_SUBDIR == 0:
      if count > 0:
        yield current_dir_index

    current_dir_index = count / FILES_PER_SUBDIR
    mkdir(mesh_path(current_dir_index))
    mkdir(json_path(current_dir_index))

    start = time()

    vbo = create_vbo(mesher, obj_id)

    object_id = str(obj_id) + ':0'
    fragment_id = object_id + ':' + chunk_name

    with open(os.path.join(mesh_path(current_dir_index), fragment_id), 'wb') as f:
      f.write(vbo)

    progress(obj_id, count + 1, len(mesher.ids()))

    end = time()

    performance[count % len(performance)] = end - start

  vprint("\nWrote " + str(len(mesher.ids())) + " VBOs to " + STAGING_DIR)

  yield current_dir_index

def upload_to_gcloud(dir_index, numdirs, dataset, bucket_name):
  if not os.path.exists(mesh_path(dir_index)):
    vprint("Not uploading non-existent directory index: {}".format(dir_index))
    return False

  try:
    vprint("Uploading VBOs to cloud storage ({}/{})...".format(dir_index, numdirs))
    subprocess.check_call('gsutil -m -h "Content-Type:application/octet-stream" cp -Z -a public-read {input_dir} gs://{bucket}/{dataset}/segmentation/mesh/'.format(
        input_dir=os.path.join(mesh_path(dir_index), '*'),
        dataset=dataset,
        bucket=bucket_name
    ), shell=True)
  except subprocess.CalledProcessError as err:
    vprint(err)
    return False

  shutil.rmtree(MESH_DIR)

  return True

def process_hdf5(filename, dataset, bucket, resolution, chunk_name):
  mesher = mesh_volume(filename)
  numdirs = int(math.ceil(float(len(mesher.ids())) / float(FILES_PER_SUBDIR)))

  for dir_index in generate_vbos(mesher, resolution, chunk_name):
      success = upload_to_gcloud(dir_index, numdirs, dataset, bucket)

      if os.path.exists(mesh_path(dir_index)) and success:
          vprint("Deleting uploaded files in directory {}".format(dir_index))
          shutil.rmtree(mesh_path(dir_index))

def collate_manifests():
  segid_to_frags = defaultdict(list)
  
  for filename in os.listdir(MANIFESTS_DIR): # iterate in manifests/json
    filepath = os.path.join(MANIFESTS_DIR, filename)
    with open(filepath, 'r') as f:
      segids = json.loads(f.read())

    chunkid = filename.replace('.json', '')

    for segid in segids:
      segid_to_frags[segid].append(
        "{}:0:{}".format(segid, chunkid)
      )

  return segid_to_frags

def generate_manifest_json():
  segid_to_frags = collate_manifests()

  for count, segid in enumerate(segid_to_frags):
    dir_index = math.floor(float(count+1) / float(FILES_PER_SUBDIR))

    filepath = os.path.join(mkdir(json_path(dir_index)), '{}:0'.format(segid))

    fragjson =  json.dumps({ 
      "fragments": segid_to_frags[segid],
    })

    with open(filepath, 'w') as f:
      f.write(fragjson) 

def upload_manifests(dataset, bucket):
  generate_manifest_json()

  dirs = os.listdir(JSON_DIR)
  for dir_index in dirs:
    vprint("Uploading JSON files to cloud storage ({}/{})...".format(dir_index, len(dirs)))
    subprocess.check_call('gsutil -m -h "Content-Type:application/json" cp -a public-read {input_dir} gs://{bucket}/{dataset}/segmentation/mesh/'.format(
      input_dir=os.path.join(json_path(dir_index), '*'),
      dataset=dataset,
      bucket=bucket
    ), shell=True)

  shutil.rmtree(JSON_DIR)

if __name__ == '__main__':
  parser = argparse.ArgumentParser(description='Mesh segmentation hdf5 and upload to GCloud in a Neuroglancer readable format.')

  parser.add_argument('--segmentation', dest='segmentation_path', action='store',
                  default=None, metavar='IMAGE_FILE_PATH',
                  help='Filepath to segmentation hdf5')

  parser.add_argument('--chunk', dest='chunk_name', action='store',
                  default='0', metavar='CHUNK_NAME',
                  help='Identifier for segment ID fragments in this chunk.')

  parser.add_argument('--dataset', dest='dataset_name', action='store',
                                metavar='DATASET_NAME',
                  help='Name of dataset to store in gcloud', required=True)

  parser.add_argument('--bucket', dest='bucket_name', action='store',
                                metavar='BUCKET_NAME',
                  help='Name of gcloud bucket to use', required=True)  

  parser.add_argument('--resolution', dest='resolution', action='store',
                              metavar='X,Y,Z',
                help='X,Y,Z comma seperated anisotropy. e.g. 6,6,30 meaning 6nm x 6nm x 30nm', required=True)  

  args = parser.parse_args()

  resolution = map(int, args.resolution.split(','))

  process_hdf5(
    filename=args.segmentation_path, 
    chunk_name=args.chunk_name,
    dataset=args.dataset_name,
    bucket=args.bucket_name,
    resolution=resolution
  )

  upload_manifests(args.dataset_name, args.bucket_name)











