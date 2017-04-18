import shutil
import numpy as np
import h5py

from neuroglancer.ingest.volumes.volumes import HDF5Volume
from neuroglancer.pipeline import Precomputed, Storage, RegionGraphTask, DiscriminateTask
from neuroglancer.pipeline.task_creation import (upload_build_chunks, create_info_file_from_build,
    create_ingest_task, MockTaskQueue)

dataset_path = 'file:///usr/people/it2/seungmount/research/ignacio/pinky/'
def create_layers(offset=[0,0,0]):
    omni_path = '/usr/people/it2/seungmount/Omni/TracerTasks/pinky/proofreading/chunk_18049-20096_30337-32384_4003-4258.omni.files/'
  
    v = HDF5Volume(omni_path+'image.h5', 'image')
    print 'creating image'
    storage = Storage(dataset_path+'image', n_threads=0)
    upload_build_chunks(storage,  v, offset)
    create_info_file_from_build(storage, layer_type= 'image', encoding='raw')
    create_ingest_task(storage, MockTaskQueue())

    v = HDF5Volume(omni_path+'mean_agg_tr.h5', 'segmentation')
    print 'creating watershed'
    storage = Storage(dataset_path+'segmentation', n_threads=0)
    upload_build_chunks(storage,  v, offset)
    create_info_file_from_build(storage, layer_type= 'segmentation', encoding='raw')
    create_ingest_task(storage, MockTaskQueue())
    
    print 'creating segmentation'
    storage = Storage(dataset_path+'watershed', n_threads=0)
    v = HDF5Volume(omni_path+'raw.h5', 'segmentation')
    upload_build_chunks(storage, v, offset)
    create_info_file_from_build(storage, layer_type= 'segmentation', encoding='raw')
    create_ingest_task(storage, MockTaskQueue())

    v = HDF5Volume(omni_path+'aff.h5', 'affinities', max_size=[512,512,128])
    storage = Storage(dataset_path+'affinities', n_threads=0)
    upload_build_chunks(storage, v, offset)
    create_info_file_from_build(storage, layer_type= 'image', encoding='raw')
    create_ingest_task(storage, MockTaskQueue())

def create_layers_quick():
    shutil.rmtree('/usr/people/it2/seungmount/research/ignacio/pinky/')
    shutil.copytree('/usr/people/it2/seungmount/research/ignacio/pinky_b','/usr/people/it2/seungmount/research/ignacio/pinky')

def test_all_stages():
    # create_layers()

    dataset_path = "s3://neuroglancer/pinky40_v3/"
    t = RegionGraphTask(
        chunk_position='28672-29824_24064-25216_0-128', 
        crop_position='192-960_192-960_16-112',
        watershed_layer=dataset_path+'watershed', 
        segmentation_layer=dataset_path+'segmentation',
        yacn_layer=dataset_path+'yacn',
        affinities_layer='s3://neuroglancer/pinky40_v4/affinitymap-jnet',
    )
    # t.execute()

    t = DiscriminateTask(
            chunk_position='0-320_0-320_0-64',
            crop_position='0-256_0-256_0-64',
            image_layer=dataset_path+'image',
            segmentation_layer=dataset_path+'segmentation',
            yacn_layer=dataset_path+'yacn',
            errors_layer=dataset_path+'errors'
)

    # print t
    # t.execute()