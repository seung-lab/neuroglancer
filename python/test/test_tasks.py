import json
import os.path
import shutil

import numpy as np

from neuroglancer.pipeline.volumes import CloudVolume, EmptyVolumeException
from neuroglancer.pipeline import (
    Storage, Precomputed, DownsampleTask, 
    MeshTask, MeshManifestTask, QuantizeAffinitiesTask,
    HyperSquareLocalizationTask)
from neuroglancer.pipeline.task_creation import create_downsample_scales, create_downsampling_tasks, create_quantized_affinity_info
from neuroglancer.pipeline.task_queue import MockTaskQueue
from neuroglancer import downsample, lib
from layer_harness import delete_layer, create_layer

def test_ingest_image():
    delete_layer()
    storage, data = create_layer(size=(256,256,128,1), offset=(0,0,0), layer_type='image')
    cv = CloudVolume(storage.layer_path)
    assert len(cv.scales) == 3
    assert len(cv.available_mips) == 3

    slice64 = np.s_[0:64, 0:64, 0:64]

    cv.mip = 0
    assert np.all(cv[slice64] == data[slice64])

    assert len(cv.available_mips) == 3
    assert np.array_equal(cv.mip_volume_size(0), [ 256, 256, 128 ])
    assert np.array_equal(cv.mip_volume_size(1), [ 128, 128, 128 ])
    assert np.array_equal(cv.mip_volume_size(2), [ 64, 64, 128 ])
    
    slice64 = np.s_[0:64, 0:64, 0:64]

    cv.mip = 0
    assert np.all(cv[slice64] == data[slice64])

    data_ds1 = downsample.downsample_with_averaging(data, factor=[2, 2, 1, 1])
    cv.mip = 1
    assert np.all(cv[slice64] == data_ds1[slice64])

    data_ds2 = downsample.downsample_with_averaging(data_ds1, factor=[2, 2, 1, 1])
    cv.mip = 2
    assert np.all(cv[slice64] == data_ds2[slice64])


def test_ingest_segmentation():
    delete_layer()
    storage, data = create_layer(size=(256,256,128,1), offset=(0,0,0), layer_type='segmentation')
    cv = CloudVolume(storage.layer_path)
    assert len(cv.scales) == 3
    assert len(cv.available_mips) == 3

    slice64 = np.s_[0:64, 0:64, 0:64]

    cv.mip = 0
    assert np.all(cv[slice64] == data[slice64])

    assert len(cv.available_mips) == 3
    assert np.array_equal(cv.mip_volume_size(0), [ 256, 256, 128 ])
    assert np.array_equal(cv.mip_volume_size(1), [ 128, 128, 128 ])
    assert np.array_equal(cv.mip_volume_size(2), [  64,  64, 128 ])
    
    slice64 = np.s_[0:64, 0:64, 0:64]

    cv.mip = 0
    assert np.all(cv[slice64] == data[slice64])

    data_ds1 = downsample.downsample_segmentation(data, factor=[2, 2, 1, 1])
    cv.mip = 1
    assert np.all(cv[slice64] == data_ds1[slice64])

    data_ds2 = downsample.downsample_segmentation(data_ds1, factor=[2, 2, 1, 1])
    cv.mip = 2
    assert np.all(cv[slice64] == data_ds2[slice64])

def test_downsample_no_offset():
    delete_layer()
    storage, data = create_layer(size=(1024,1024,128,1), offset=(0,0,0))
    cv = CloudVolume(storage.layer_path)
    assert len(cv.scales) == 5
    assert len(cv.available_mips) == 5

    cv.commitInfo()

    create_downsampling_tasks(MockTaskQueue(), storage.layer_path, mip=0, num_mips=4)

    cv.refreshInfo()

    assert len(cv.available_mips) == 5
    assert np.array_equal(cv.mip_volume_size(0), [ 1024, 1024, 128 ])
    assert np.array_equal(cv.mip_volume_size(1), [  512,  512, 128 ])
    assert np.array_equal(cv.mip_volume_size(2), [  256,  256, 128 ])
    assert np.array_equal(cv.mip_volume_size(3), [  128,  128, 128 ])
    assert np.array_equal(cv.mip_volume_size(4), [   64,   64, 128 ])
    
    slice64 = np.s_[0:64, 0:64, 0:64]

    cv.mip = 0
    assert np.all(cv[slice64] == data[slice64])

    data_ds1 = downsample.downsample_with_averaging(data, factor=[2, 2, 1, 1])
    cv.mip = 1
    assert np.all(cv[slice64] == data_ds1[slice64])

    data_ds2 = downsample.downsample_with_averaging(data_ds1, factor=[2, 2, 1, 1])
    cv.mip = 2
    assert np.all(cv[slice64] == data_ds2[slice64])

    data_ds3 = downsample.downsample_with_averaging(data_ds2, factor=[2, 2, 1, 1])
    cv.mip = 3
    assert np.all(cv[slice64] == data_ds3[slice64])

    data_ds4 = downsample.downsample_with_averaging(data_ds3, factor=[2, 2, 1, 1])
    cv.mip = 4
    assert np.all(cv[slice64] == data_ds4[slice64])

def test_downsample_with_offset():
    delete_layer()
    storage, data = create_layer(size=(512,512,128,1), offset=(3,7,11))
    cv = CloudVolume(storage.layer_path)
    assert len(cv.scales) == 4
    assert len(cv.available_mips) == 4

    cv.commitInfo()

    create_downsampling_tasks(MockTaskQueue(), storage.layer_path, mip=0, num_mips=3)

    cv.refreshInfo()

    assert len(cv.available_mips) == 4
    assert np.array_equal(cv.mip_volume_size(0), [ 512, 512, 128 ])
    assert np.array_equal(cv.mip_volume_size(1), [ 256, 256, 128 ])
    assert np.array_equal(cv.mip_volume_size(2), [ 128, 128, 128 ])
    assert np.array_equal(cv.mip_volume_size(3), [  64,  64, 128 ])

    assert np.all(cv.mip_voxel_offset(3) == (0,0,11))
    
    cv.mip = 0
    assert np.all(cv[3:67, 7:71, 11:75] == data[0:64, 0:64, 0:64])

    data_ds1 = downsample.downsample_with_averaging(data, factor=[2, 2, 1, 1])
    cv.mip = 1
    assert np.all(cv[1:33, 3:35, 11:75] == data_ds1[0:32, 0:32, 0:64])

    data_ds2 = downsample.downsample_with_averaging(data_ds1, factor=[2, 2, 1, 1])
    cv.mip = 2
    assert np.all(cv[0:16, 1:17, 11:75] == data_ds2[0:16, 0:16, 0:64])

    data_ds3 = downsample.downsample_with_averaging(data_ds2, factor=[2, 2, 1, 1])
    cv.mip = 3
    assert np.all(cv[0:8, 0:8, 11:75] == data_ds3[0:8,0:8,0:64])

def test_downsample_w_missing():
    delete_layer()
    storage, data = create_layer(size=(512,512,128,1), offset=(3,7,11))
    cv = CloudVolume(storage.layer_path)
    assert len(cv.scales) == 4
    assert len(cv.available_mips) == 4
    delete_layer()

    cv.commitInfo()

    try:
        create_downsampling_tasks(MockTaskQueue(), storage.layer_path, mip=0, num_mips=3, fill_missing=False)
    except EmptyVolumeException:
        pass

    create_downsampling_tasks(MockTaskQueue(), storage.layer_path, mip=0, num_mips=3, fill_missing=True)

    cv.refreshInfo()

    assert len(cv.available_mips) == 4
    assert np.array_equal(cv.mip_volume_size(0), [ 512, 512, 128 ])
    assert np.array_equal(cv.mip_volume_size(1), [ 256, 256, 128 ])
    assert np.array_equal(cv.mip_volume_size(2), [ 128, 128, 128 ])
    assert np.array_equal(cv.mip_volume_size(3), [  64,  64, 128 ])

    assert np.all(cv.mip_voxel_offset(3) == (0,0,11))
    
    cv.mip = 0
    cv.fill_missing = True
    assert np.count_nonzero(cv[3:67, 7:71, 11:75]) == 0

def test_downsample_higher_mip():
    delete_layer()
    storage, data = create_layer(size=(512,512,64,1), offset=(3,7,11))
    cv = CloudVolume(storage.layer_path)
    cv.info['scales'] = cv.info['scales'][:1]
    
    cv.commitInfo()
    create_downsampling_tasks(MockTaskQueue(), storage.layer_path, mip=0, num_mips=2)
    cv.refreshInfo()
    assert len(cv.available_mips) == 3

    create_downsampling_tasks(MockTaskQueue(), storage.layer_path, mip=1, num_mips=2)
    cv.refreshInfo()
    assert len(cv.available_mips) == 4

    cv.mip = 3
    assert cv[:,:,:].shape == (64,64,64,1)

def test_mesh():
    delete_layer()
    storage, _ = create_layer(size=(64,64,64,1), offset=(0,0,0), layer_type="segmentation")
    cv = CloudVolume(storage.layer_path)
    # create a box of ones surrounded by zeroes
    data = np.zeros(shape=(64,64,64,1), dtype=np.uint32)
    data[1:-1,1:-1,1:-1,:] = 1
    cv[0:64,0:64,0:64] = data

    t = MeshTask(
        shape=(64,64,64),
        offset=(0,0,0),
        layer_path=storage.layer_path,
        mip=0,
    )
    t.execute()
    assert storage.get_file('mesh/1:0:0-64_0-64_0-64') is not None 
    assert list(storage.list_files('mesh/')) == ['mesh/1:0:0-64_0-64_0-64']

def test_quantize_affinities():
    qpath = 'file:///tmp/removeme/quantized/'

    delete_layer()
    delete_layer(qpath)

    storage, _ = create_layer(size=(256,256,128,3), offset=(0,0,0), layer_type="affinity")
    cv = CloudVolume(storage.layer_path)

    shape = (128, 128, 64)
    slices = np.s_[ :shape[0], :shape[1], :shape[2], :1 ]

    data = cv[slices]
    data *= 255.0
    data = data.astype(np.uint8)

    task = QuantizeAffinitiesTask(
        source_layer_path=storage.layer_path,
        dest_layer_path=qpath,
        shape=shape,
        offset=(0,0,0),
    )

    info = create_quantized_affinity_info(storage.layer_path, qpath, shape)
    qcv = CloudVolume(qpath, info=info)
    qcv.commitInfo()

    create_downsample_scales(qpath, mip=0, ds_shape=shape)

    task.execute()

    qcv.mip = 0

    qdata = qcv[slices]

    assert np.all(data.shape == qdata.shape)
    assert np.all(data == qdata)
    assert data.dtype == np.uint8

def test_mesh_manifests():
    directory = '/tmp/removeme/mesh_manifests/'
    layer_path = 'file://' + directory
    mesh_dir = 'mesh_mip_3_error_40'

    delete_layer(layer_path)

    to_path = lambda filename: os.path.join(directory, mesh_dir, filename)

    n_segids = 100
    n_lods = 2
    n_fragids = 5

    with Storage(layer_path) as stor:
        stor.put_file('info', '{"mesh":"mesh_mip_3_error_40"}')

    for segid in xrange(n_segids):
        for lod in xrange(n_lods):
            for fragid in xrange(n_fragids):
                filename = '{}:{}:{}'.format(segid, lod, fragid)
                lib.touch(to_path(filename))

    for i in xrange(10):
        MeshManifestTask(layer_path=layer_path, prefix=i, lod=0).execute()

    for segid in xrange(n_segids):
        for fragid in xrange(n_fragids):
            filename = '{}:0'.format(segid)
            assert os.path.exists(to_path(filename))
            filename = '{}:1'.format(segid)
            assert not os.path.exists(to_path(filename))

    for i in xrange(10):
        MeshManifestTask(layer_path=layer_path, prefix=i, lod=1).execute()

    for segid in xrange(n_segids):
        for fragid in xrange(n_fragids):
            filename = '{}:0'.format(segid)
            assert os.path.exists(to_path(filename))
            filename = '{}:1'.format(segid)
            assert os.path.exists(to_path(filename))

    with open(to_path('50:0'), 'r') as f:
        content = json.loads(f.read())
        assert content == {"fragments": [ "50:0:0","50:0:1","50:0:2","50:0:3","50:0:4" ]}

    if os.path.exists(directory):
        shutil.rmtree(directory)

def test_hypersquare_localization_remap():
    delete_layer()
    storage, image = create_layer(
        size=(64,64,64,1), 
        offset=(0,0,0), 
        layer_type="segmentation",
        dtype=np.uint16, # hypersquare is uint16
    )

    image32 = image.astype(np.uint32) + 65536

    info = storage.get_file('info')

    dest_path = 'file:///tmp/removeme/hypersquare/test/'

    with Storage(dest_path) as stor:
        info = info.replace('uint16', 'uint32')
        stor.put_file('info', info, 'application/json')

    task = HyperSquareLocalizationTask(
        src_path=storage.layer_path,
        dest_path=dest_path,
        high_value=1,
        shape=(64,64,64),
        offset=(0,0,0)
    )

    task.execute()

    vol = CloudVolume(dest_path)
    destimg = vol[0:64, 0:64, 0:64]
    print(image32[0:2,0:2,0:2], destimg[0:2,0:2,0:2])
    assert np.all(image32 == destimg)

















