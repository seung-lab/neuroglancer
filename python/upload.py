import json
import numpy as np
import h5py
import os
from itertools import product
from neuroglancer import chunks
from google.cloud import storage
import zlib
from tqdm import tqdm
import subprocess
import shutil
import random

STAGING_DIR = 'staging'# + str(random.randint(0, 10000))

client = storage.Client(project='neuromancer-seung-import')
bucket = client.get_bucket('neuroglancer-dev')

DATASET_NAME = 'snemi3d'

def generateStagingMaterials(img, info, layer_name):
  for scale in info["scales"]:

    staging_dir = './' + STAGING_DIR + '/' + layer_name + '/' + scale['key']
    os.makedirs(staging_dir)

    for chunk_size in scale["chunk_sizes"]:
      n_chunks = np.array(scale["size"]) / np.array(chunk_size)
      
      x_chunk_size = chunk_size[0]
      y_chunk_size = chunk_size[1]
      z_chunk_size = chunk_size[2]

      dirname = '{}/{}/{}/'.format(DATASET_NAME, layer_name, scale["key"])

      for x,y,z in tqdm(product(*list(map(xrange, n_chunks)))):
        img_chunk = img[
          (z * z_chunk_size) : (z + 1) * z_chunk_size,
          (y * y_chunk_size) : (y + 1) * y_chunk_size,
          (x * x_chunk_size) : (x + 1) * x_chunk_size
        ]

        content_type = 'application/octet-stream'
        content_encoding = None

        if scale["encoding"] == "jpeg":
          content_type = 'image/jpeg'
          encoded = chunks.encode_jpeg(img_chunk)
        elif scale["encoding"] == "npz":
          encoded = chunks.encode_npz(img_chunk)
        elif scale["encoding"] == "raw":
          content_encoding = 'gzip'
          encoded = chunks.encode_raw(img_chunk)
          # encoded = zlib.compress(encoded, 8)
        else:
          raise NotImplemented

        filename = '{}-{}_{}-{}_{}-{}'.format(
          x * x_chunk_size, (x + 1) * x_chunk_size,
          y * y_chunk_size, (y + 1) * y_chunk_size,
          z * z_chunk_size, (z + 1) * z_chunk_size
        ) 

        # blob = storage.blob.Blob(dirname + filename, bucket)
        # blob.content_encoding = content_encoding
        # blob.content_type = content_type
        # blob.cache_control = 'no-cache'

        with open(staging_dir + '/' + filename, 'w+') as f:
          f.write(encoded)

    yield staging_dir, scale['key']


def upload_hdf5(hdf5_filename, info, layer):
  print("Processing " + layer)
  with h5py.File(hdf5_filename) as f:
    img = f['main']

    print("Uploading Info")
    blob = storage.blob.Blob('{}/{}/info'.format(DATASET_NAME, layer), bucket)
    blob.upload_from_string(json.dumps(info))
    blob.make_public()

    print("Generating staging files...")
    for staging_dir, key in generateStagingMaterials(img, info, layer):
      print("Uploading " + key)
      gsutil_upload_command = "gsutil -m cp -Z -a public-read {}/* gs://neuroglancer-dev/snemi3d/{}/{}/".format(
        staging_dir, layer, key
      )
      print(gsutil_upload_command)
      subprocess.call(gsutil_upload_command, shell=True)

chunk_size = 64
isotropic_chunk_size = [ chunk_size, chunk_size, chunk_size ]
volume_size = [ 1024, 1024, 100 ]
resolution = [ 6, 6, 30 ]

image_info = {
  "data_type": "uint8",
  "num_channels": 1,
  "scales": [{
    "chunk_sizes": [ isotropic_chunk_size ],
    "encoding": "jpeg", 
    "key": "6_6_30",
    "resolution": resolution,
    "size": volume_size,
    "voxel_offset": [ 0, 0, 0 ],
  }], 
  "type": "image",
}

segmentation_info = {
  "data_type": "uint32",
  "num_channels": 1,
  "mesh": "mesh",
  "scales": [{
    "chunk_sizes": [ isotropic_chunk_size ],
    "encoding": "raw", 
    "key": "6_6_30",
    "resolution": resolution,
    "size": volume_size,
    "voxel_offset": [ 0, 0, 0 ],
  }], 
  "type": "segmentation",
}

upload_hdf5('./snemi3d/image.h5', image_info, 'image')
upload_hdf5('./snemi3d/machine_labels.h5', segmentation_info, 'segmentation')
# now need to upload meshes

# https://neuroglancer-demo.appspot.com/#!{'layers':{'raw_image':{'type':'image'_'source':'precomputed://gs://neuroglancer/snemi3d/raw_image'}}_'navigation':{'pose':{'position':{'voxelSize':[6_6_30]_'voxelCoordinates':[512_512_64]}}_'zoomFactor':6}}




