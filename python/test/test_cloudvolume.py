import pytest

import shutil
import numpy as np

from neuroglancer.pipeline.storage import Storage
from neuroglancer.pipeline.volumes import CloudVolume
from neuroglancer.pipeline.task_creation import (upload_build_chunks, create_info_file_from_build,
    create_ingest_task, MockTaskQueue)

from layer_harness import delete_layer, create_layer
    
def test_aligned_read():
    delete_layer()
    storage, data = create_layer(size=(50,50,50,1), offset=(0,0,0))
    cv = CloudVolume(storage.layer_path)
    #the last dimension is the number of channels
    assert cv[0:50,0:50,0:50].shape == (50,50,50,1)
    assert np.all(cv[0:50,0:50,0:50] == data)

    storage.kill_threads()
    
    delete_layer()
    storage, data = create_layer(size=(128,64,64,1), offset=(0,0,0))
    cv = CloudVolume(storage.layer_path)
    #the last dimension is the number of channels
    assert cv[0:64,0:64,0:64].shape == (64,64,64,1) 
    assert np.all(cv[0:64,0:64,0:64] ==  data[:64,:64,:64,:])

    storage.kill_threads()

    delete_layer()
    storage, data = create_layer(size=(128,64,64,1), offset=(10,20,0))
    cv = CloudVolume(storage.layer_path)
    cutout = cv[10:74,20:84,0:64]
    #the last dimension is the number of channels
    assert cutout.shape == (64,64,64,1) 
    assert np.all(cutout == data[:64,:64,:64,:])
    #get the second chunk
    cutout2 = cv[74:138,20:84,0:64]
    assert cutout2.shape == (64,64,64,1) 
    assert np.all(cutout2 == data[64:128,:64,:64,:])

    storage.kill_threads()

def test_non_aligned_read():
    delete_layer()
    storage, data = create_layer(size=(128,64,64,1), offset=(0,0,0))
    cv = CloudVolume(storage.layer_path)
    #the last dimension is the number of channels
    assert cv[31:65,0:64,0:64].shape == (34,64,64,1) 
    assert np.all(cv[31:65,0:64,0:64] == data[31:65,:64,:64,:])
    storage.kill_threads()

    #read a single pixel
    delete_layer()
    storage, data = create_layer(size=(64,64,64,1), offset=(0,0,0))
    cv = CloudVolume(storage.layer_path)
    #the last dimension is the number of channels
    assert cv[22:23,22:23,22:23].shape == (1,1,1,1) 
    assert np.all(cv[22:23,22:23,22:23] == data[22:23,22:23,22:23,:])
    storage.kill_threads()

    # Test steps (negative steps are not supported)
    img1 = cv[::2, ::2, ::2, :]
    img2 = cv[:, :, :, :][::2, ::2, ::2, :]
    assert np.array_equal(img1, img2)

def test_write():
    delete_layer()
    storage, data = create_layer(size=(50,50,50,1), offset=(0,0,0))
    cv = CloudVolume(storage.layer_path)

    replacement_data = np.zeros(shape=(50,50,50,1), dtype=np.uint8)
    cv[0:50,0:50,0:50] = replacement_data
    assert np.all(cv[0:50,0:50,0:50] == replacement_data)

    replacement_data = np.random.randint(255, size=(50,50,50,1), dtype=np.uint8)
    cv[0:50,0:50,0:50] = replacement_data
    assert np.all(cv[0:50,0:50,0:50] == replacement_data)

    # out of bounds
    delete_layer()
    storage, data = create_layer(size=(128,64,64,1), offset=(10,20,0))
    cv = CloudVolume(storage.layer_path)
    with pytest.raises(ValueError):
        cv[74:150,20:84,0:64] = np.ones(shape=(64,64,64,1), dtype=np.uint8)
    storage.kill_threads()
    
    # non-aligned writes
    delete_layer()
    storage, data = create_layer(size=(128,64,64,1), offset=(10,20,0))
    cv = CloudVolume(storage.layer_path)
    with pytest.raises(ValueError):
        cv[21:85,0:64,0:64] = np.ones(shape=(64,64,64,1), dtype=np.uint8)
    storage.kill_threads()

def test_writer_last_chunk_smaller():
    """
    we make it believe the last chunk is smaller by hacking the info file
    """
    delete_layer()
    storage, data = create_layer(size=(128,64,64,1), offset=(0,0,0))
    cv = CloudVolume(storage.layer_path)
    
    chunks = [ chunk for chunk in cv._generate_chunks(data[:100,:,:,:], (0,0,0)) ]

    assert len(chunks) == 2

    img, spt, ept = chunks[0]
    assert np.array_equal(spt, (0,0,0))
    assert np.array_equal(ept, (64,64,64))
    assert img.shape == (64,64,64,1)

    img, spt, ept = chunks[1]
    assert np.array_equal(spt, (64,0,0))
    assert np.array_equal(ept, (100,64,64))
    assert img.shape == (36,64,64,1)

# def test_reader_negative_indexing():
#     """negative indexing is supported"""
#     delete_layer()
#     storage, data = create_layer(size=(128,64,64,1), offset=(0,0,0))
#     cv = CloudVolume(storage.layer_path)

#     # Test negative beginnings
#     img1 = cv[-1:, -1:, -1:, :]
#     img2 = cv[:, :, :, :][-1:, -1:, -1:, :]

#     assert np.array_equal(img1, img2)    

#     # Test negative ends
#     with pytest.raises(ValueError):
#         img1 = cv[::-1, ::-1, ::-1, :]

def test_setitem_mismatch():
    delete_layer()
    storage, data = create_layer(size=(64,64,64,1), offset=(0,0,0))
    cv = CloudVolume(storage.layer_path)

    with pytest.raises(ValueError):
        cv[0:64,0:64,0:64] = np.zeros(shape=(5,5,5,1), dtype=np.uint8)

def test_bounds():
    delete_layer()
    storage, data = create_layer(size=(128,64,64,1), offset=(100,100,100))
    cv = CloudVolume(storage.layer_path, bounded=True)
    try:
        cutout = cv[0:,0:,0:,:]
        cutout = cv[100:229,100:165,100:165,0]
        cutout = cv[99:228,100:164,100:164,0]
    except ValueError:
        pass
    else:
        assert False

    # don't die
    cutout = cv[100:228,100:164,100:164,0]

    cv.bounded = False
    cutout = cv[0:,0:,0:,:]
    assert cutout.shape == (228, 164, 164, 1)

    assert np.count_nonzero(cutout) != 0

    cutout[100:,100:,100:,:] = 0

    assert np.count_nonzero(cutout) == 0

    storage.kill_threads()

def test_extract_path():
    def shoulderror(url):
        try:
            path = CloudVolume.extract_path(url)
            assert False, url
        except:
            pass

    def okgoogle(url):
        path = CloudVolume.extract_path(url)
        assert path.protocol == 'gs', url
        assert path.bucket_name == 'bucket', url
        assert path.dataset_name == 'dataset', url
        assert path.layer_name == 'layer', url
       

    shoulderror('ou3bouqjsa fkj aojsf oaojf ojsaf')

    okgoogle('gs://bucket/dataset/layer/')
    okgoogle('gs://bucket/dataset/layer/info')

    path = CloudVolume.extract_path('s3://bucketxxxxxx/datasetzzzzz91h8__3/layer1br9bobasjf/')
    assert path.protocol == 's3'
    assert path.bucket_name == 'bucketxxxxxx'
    assert path.dataset_name == 'datasetzzzzz91h8__3'
    assert path.layer_name == 'layer1br9bobasjf'

    path = CloudVolume.extract_path('file://bucket/dataset/layer/')
    assert path.protocol == 'file'
    assert path.bucket_name == 'bucket'
    assert path.dataset_name == 'dataset'
    assert path.layer_name == 'layer'

    shoulderror('lucifer://bucket/dataset/layer/')
    shoulderror('gs://///')
    shoulderror('gs://neuroglancer//segmentation')

    path = CloudVolume.extract_path('file:///tmp/removeme/layer/')
    assert path.protocol == 'file'
    assert path.bucket_name == '/tmp'
    assert path.dataset_name == 'removeme'
    assert path.layer_name == 'layer'
