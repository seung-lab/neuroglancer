import pytest
import re
import time
import shutil

from neuroglancer.pipeline.storage import Storage, wait_full_jitter

def test_path_extraction():
    assert (Storage.extract_path('s3://bucket_name/dataset_name/layer_name') 
        == Storage.ExtractedPath('s3', "bucket_name", None, 'dataset_name', 'layer_name'))

    assert Storage.extract_path('s4://dataset_name/layer_name') is None

    assert Storage.extract_path('dataset_name/layer_name') is None

    assert Storage.extract_path('s3://dataset_name') is None

    assert (Storage.extract_path('s3://neuroglancer/intermediate/path/dataset_name/layer_name') 
        == Storage.ExtractedPath('s3', 'neuroglancer', 'intermediate/path/','dataset_name', 'layer_name'))

    assert (Storage.extract_path('file:///tmp/dataset_name/layer_name') 
        == Storage.ExtractedPath('file', "/tmp",  None, 'dataset_name', 'layer_name'))

    assert (Storage.extract_path('file://neuroglancer/intermediate/path/dataset_name/layer_name') 
        == Storage.ExtractedPath('file', 'neuroglancer','intermediate/path/','dataset_name', 'layer_name'))

    assert (Storage.extract_path('gs://neuroglancer/intermediate/path/dataset_name/layer_name') 
        == Storage.ExtractedPath('gs', 'neuroglancer', 'intermediate/path/','dataset_name', 'layer_name'))

    assert Storage.extract_path('s3://dataset_name/layer_name/') is None

#TODO delete files created by tests
def test_read_write():
    urls = ["file:///tmp/removeme/read_write",
            "gs://neuroglancer/removeme/read_write",
            "s3://neuroglancer/removeme/read_write"]

    for num_threads in xrange(0,2):
        for url in urls:
            with Storage(url, n_threads=num_threads) as s:
                content = 'some_string'
                s.put_file('info', content, content_type='application/json', compress=False).wait()
                assert s.get_file('info') == content
                assert s.get_file('nonexistentfile') is None

                num_infos = max(num_threads, 1)

                results = s.get_files([ 'info' for i in xrange(num_infos) ])

                assert len(results) == num_infos
                assert results[0]['filename'] == 'info'
                assert results[0]['content'] == content
                assert all(map(lambda x: x['error'] is None, results))
                assert s.get_files([ 'nonexistentfile' ])[0]['content'] is None

    shutil.rmtree("/tmp/removeme/read_write")

def test_compression():
    urls = [  
        "file:///tmp/removeme/compression",
        "gs://neuroglancer/removeme/compression",
        "s3://neuroglancer/removeme/compression"
    ]

    for url in urls:
        with Storage(url, n_threads=5) as s:
            content = 'some_string'
            s.put_file('info', content, compress=True)
            s.wait()
            assert s.get_file('info') == content
            assert s.get_file('nonexistentfile') is None
            s.delete_file('info')

def test_list():  
    urls = ["file:///tmp/removeme/list",
            "gs://neuroglancer/removeme/list",
            "s3://neuroglancer/removeme/list"]

    for url in urls:
        with Storage(url, n_threads=5) as s:
            content = 'some_string'
            s.put_file('info1', content, compress=False)
            s.put_file('info2', content, compress=False)
            s.put_file('build/info3', content, compress=False)
            s.put_file('info4', content, compress=True)
            s.put_file('info.txt', content, compress=False)
            s.wait()
            time.sleep(1) # sometimes it takes a moment for google to update the list
            assert set(s.list_files(prefix='')) == set(['info1','info2','info4','info.txt'])
            assert set(s.list_files(prefix='inf')) == set(['info1','info2','info4','info.txt'])
            assert set(s.list_files(prefix='info1')) == set(['info1'])
            assert set(s.list_files(prefix='build')) == set([])
            assert set(s.list_files(prefix='build/')) == set(['info3'])
            assert set(s.list_files(prefix='nofolder/')) == set([])
            for file_path in ('info1', 'info2', 'build/info3', 'info4', 'info.txt'):
                s.delete_file(file_path)
    
    shutil.rmtree("/tmp/removeme/list")

def test_threads_die():
    s = Storage('file:///tmp/removeme/wow', n_threads=40)
    assert s.are_threads_alive()
    s.kill_threads()
    assert not s.are_threads_alive()

    s = Storage('file:///tmp/removeme/wow', n_threads=0)
    assert not s.are_threads_alive()

    with Storage('file:///tmp/removeme/wow', n_threads=40) as s:
        threads = s._threads
    
    assert not any(map(lambda t: t.isAlive(), threads))

def test_retry():
    urls = [
        "gs://neuroglancer/removeme/retry",
        "s3://neuroglancer/removeme/retry"
    ]

    for url in urls:
        with Storage(url, n_threads=20) as s:
            s.put_file('exists', 'some string', compress=False).wait()
            results = s.get_files([ 'exists' for _ in xrange(200) ])

            for result in results:
                assert result['error'] is None
                assert result['content'] == 'some string'

            assert len(result) == 200

def test_wait_full_jitter():
    fn = wait_full_jitter(0.5, 60.0)

    for _ in xrange(1000):
       assert 0 <= fn(0,0) <= 0.5
       assert 0 <= fn(1,0) <= 1.0
       assert 0 <= fn(2,0) <= 2.0
       assert 0 <= fn(3,0) <= 4.0
       assert 0 <= fn(4,0) <= 8.0
       assert 0 <= fn(5,0) <= 16.0
       assert 0 <= fn(6,0) <= 32.0
       assert 0 <= fn(7,0) <= 60.0
       assert 0 <= fn(8,0) <= 60.0
       assert 0 <= fn(9,0) <= 60.0

    def test_assertions(fn):
        failed = True
        try:
            fn()
            failed = False
        except AssertionError:
            pass
        finally:
            assert failed

    test_assertions(lambda: wait_full_jitter(-1, 0))
    test_assertions(lambda: wait_full_jitter(0, -1))

    fn = wait_full_jitter(10, 5)
    for _ in xrange(1000):
        assert 0.00 <= fn(0,0) <= 5.00

    # Default arguments exist
    fn = wait_full_jitter()
    fn(0,0)

def test_wait_full_jitter_statistically():
    fn = wait_full_jitter(0.5, 60.0)

    attempt = []
    for i in xrange(10):
        attempt.append(
            [ fn(i,0) for _ in xrange(4000) ]
        )

    mean = lambda lst: float(sum(lst)) / float(len(lst))
    
    assert  0.20 <= mean(attempt[0]) <=  0.30
    assert  0.35 <= mean(attempt[1]) <=  0.65
    assert  0.75 <= mean(attempt[2]) <=  1.25
    assert  1.75 <= mean(attempt[3]) <=  3.25
    assert  3.50 <= mean(attempt[4]) <=  5.50
    assert  7.00 <= mean(attempt[5]) <=  9.00
    assert 14.00 <= mean(attempt[6]) <= 18.00
    assert 28.00 <= mean(attempt[7]) <= 34.00
    assert 28.00 <= mean(attempt[8]) <= 34.00
    assert 28.00 <= mean(attempt[9]) <= 34.00






















