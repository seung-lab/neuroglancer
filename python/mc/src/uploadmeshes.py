# Python running example

from __future__ import print_function
import h5py
import numpy as np
import os
import sys
from mesher import Mesher
import subprocess
import json
import math
import shutil

from time import time

STAGING_DIR = os.environ['HOME'] + '/neuroglancer/python/staging/meshes/'
OBJ_DIR = STAGING_DIR + 'obj/'

MESHES_PER_SUBDIR = 1500

EPSILON = sys.float_info.epsilon

performance = [ EPSILON for i in range(300) ]

def progress(obj_id, count, N):
	items = min(len(performance), count)
	persec = float(items) / sum(performance) 

	print("writing {}\t({}/{}, {:0.2f}/sec) ...\r".format(obj_id, count, N, persec), end="")
	sys.stdout.flush()

def mkdir(path):
	if not os.path.exists(path):
		os.makedirs(path)

def mesh_path(i):
	return os.path.join(STAGING_DIR, str(i))

def json_path(i):
	return os.path.join(mesh_path(i), 'json')

def mesh_volume(labels_file):
	mesher = Mesher()

	with h5py.File(labels_file) as f:
	  arr = f['main'][:]
	  print("meshing...")
	  mesher.mesh(arr.flatten(), *arr.shape)

	return mesher

def scaled_points(points, resolution):
	# print("before", points)
	points /= 2.0

	points[0::3] *= resolution[0] 
	points[1::3] *= resolution[1] 
	points[2::3] *= resolution[2] 
	# print("after", points)

	return points

def generate_vbos(mesher):
	mkdir(STAGING_DIR)
	mkdir(OBJ_DIR)

	current_dir_index = 0

	# 

	print("generating VBO fragments and metadata json...")
	for count, obj_id in enumerate(mesher.ids()):
		# mesher.write_obj(obj_id, OBJ_DIR + str(obj_id) + '.obj')

		if count % MESHES_PER_SUBDIR == 0:
			if count > 0:
				yield current_dir_index

			current_dir_index = count / MESHES_PER_SUBDIR
			mkdir(mesh_path(current_dir_index))
			mkdir(json_path(current_dir_index))

		start = time()

		mesh = mesher.get_mesh(obj_id)

		numpoints = len(mesh['points']) / 3
		numindicies = len(mesh['faces'])

		points = np.array(mesh['points'], dtype=np.float32)
		scalepoints = scaled_points(points, [ 6, 6, 30 ]) # 6,6,30 is the resolution of snemi3d

		vertex_index_format = [
			np.array([ numpoints ], dtype=np.uint32),
			np.array(scalepoints, dtype=np.float32),
			np.array(mesh['faces'], dtype=np.uint32)
		]

		vbo = b''.join([ array.tobytes() for array in vertex_index_format ])

		progress(obj_id, count + 1, len(mesher.ids()))

		object_id = str(obj_id) + ':0'
		fragment_id = object_id + ':0'

		fragment_information = {
			"fragments": [ fragment_id ]
		}

		with open(os.path.join(mesh_path(current_dir_index), fragment_id), 'wb') as f:
			f.write(vbo)

		with open(os.path.join(json_path(current_dir_index), object_id), 'w+') as f:
			f.write(json.dumps(fragment_information))

		end = time()

		performance[count % len(performance)] = end - start

	print("\nWrote " + str(len(mesher.ids())) + " VBOs to " + STAGING_DIR)

	yield current_dir_index

def upload_to_gcloud(dir_index, numdirs=0):
	if not os.path.exists(mesh_path(dir_index)):
		print("Not uploading non-existent directory index: {}".format(dir_index))
		return False

	try:
		print("Uploading JSON files to cloud storage ({}/{})...".format(dir_index, numdirs))
		subprocess.check_call('gsutil -m -h "Content-Type:application/json" cp -a public-read {} gs://neuroglancer-dev/snemi3d/segmentation/mesh/'.format(
			os.path.join(json_path(dir_index), '*')
		), shell=True)

		print("Uploading VBOs to cloud storage ({}/{})...".format(dir_index, numdirs))
		subprocess.check_call('gsutil -m -h "Content-Type:application/octet-stream" cp -Z -a public-read {} gs://neuroglancer-dev/snemi3d/segmentation/mesh/'.format(
			os.path.join(mesh_path(dir_index), '*')
		), shell=True)
	except subprocess.CalledProcessError as err:
		print(err)
		return False

	return True

labels_file = sys.argv[1]
print("Selected labels file: " + labels_file)

mesher = mesh_volume(labels_file)
numdirs = int(math.ceil(float(len(mesher.ids())) / float(MESHES_PER_SUBDIR)))

for dir_index in generate_vbos(mesher):
	success = upload_to_gcloud(dir_index, numdirs)

	if os.path.exists(mesh_path(dir_index)) and success:
		print("Deleting uploaded files in directory {}".format(dir_index))
		shutil.rmtree(mesh_path(dir_index))









