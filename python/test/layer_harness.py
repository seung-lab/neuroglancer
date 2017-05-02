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

def create_layer(size, offset, layer_type="image"):
    storage = create_storage()

    if layer_type == "image":
        random_data = np.random.randint(255, size=size, dtype=np.uint8)
        upload_build_chunks(storage, random_data, offset)
        # Jpeg encoding is lossy so it won't work
        create_info_file_from_build(storage.layer_path, layer_type='image', encoding="raw", resolution=[1,1,1])
    else:
        random_data = np.random.randint(0xFFFFFF, size=size, dtype=np.uint32)
        upload_build_chunks(storage, random_data, offset)
        # Jpeg encoding is lossy so it won't work
        create_info_file_from_build(storage.layer_path, layer_type='segmentation', encoding="raw", resolution=[1,1,1])
    create_ingest_task(storage, MockTaskQueue())
    
    return storage, random_data

def delete_layer():
    global layer_path

    if os.path.exists(layer_path):
        shutil.rmtree(layer_path)  
    