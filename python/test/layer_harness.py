import pytest

import shutil
import numpy as np

import os

from neuroglancer.pipeline.storage import Storage
from neuroglancer.pipeline.task_creation import (upload_build_chunks, create_info_file_from_build,
    create_ingest_task, MockTaskQueue)

layer_path = '/tmp/removeme/layer'

def create_storage():
    return Storage('file://' + layer_path, n_threads=0)

def create_layer(size, offset, layer_type="image", dtype=None):

    default = lambda dt: dtype or dt

    if layer_type == "image":
        random_data = np.random.randint(255, size=size, dtype=default(np.uint8))
    elif layer_type == 'affinities':
        random_data = np.random.uniform(low=0, high=1, size=size).astype(default(np.float32))
    elif layer_type == "segmentation":
        random_data = np.random.randint(0xFFFFFF, size=size, dtype=np.uint32)
    else:
        high = np.array([0], dtype=default(np.uint32)) - 1
        random_data = np.random.randint(high[0], size=size, dtype=default(np.uint32))
        
    storage = upload_image(random_data, offset, layer_type)
    
    return storage, random_data

def upload_image(image, offset, layer_type):
    storage = create_storage()
    upload_build_chunks(storage, image, offset)
    # Jpeg encoding is lossy so it won't work
    create_info_file_from_build(storage.layer_path, layer_type=layer_type, encoding="raw", resolution=[1,1,1])
    create_ingest_task(storage, MockTaskQueue())
    return storage

def delete_layer(path=layer_path):
    if os.path.exists(path):
        shutil.rmtree(path)  

    
    
    