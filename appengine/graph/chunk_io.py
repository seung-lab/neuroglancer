import os
import logging
from StringIO import StringIO

from lru import LRU
import googleapiclient.discovery
import gzip

from chunks import Chunk

# logging.getLogger().setLevel(logging.DEBUG)

#TODO compute capacity based on average graph size
# and instance memory use env variable GAE_MEMORY_MB

# TODO for some reason it has to be larger than 3
# otherwise tests fails
# figure out why
capacity = 3
PRODUCTION = False
if ('PRODUCTION' in os.environ and 
   os.environ['PRODUCTION'] == 'true'):
   PRODUCTION = True

def download_chunk(key):
    """
    Returns None if chunk doesn't exists
    We could use big table to have low latency to this data
    But let's use google cloud storage for now
    """
    logging.debug('download_chunk name={}, chunk_key={}'.format(*key))
    if PRODUCTION:
        return uncompress(read_file_gcs(key))
    else:
        return uncompress(read_file_local(key))

def upload_chunk(key, chunk):
    if not chunk.is_dirty:
        return 
    logging.debug('upload_chunk name={}, chunk_key={},'.format(*key))
    if PRODUCTION:
        put_file_gcs(key, compress(chunk.to_string()))
    else:
        put_file_local(key, compress(chunk.to_string()))

CACHE = LRU(capacity, callback=upload_chunk)
def evict_cache():
    #TODO actually evict 
    CACHE.clear()
    
evict_cache()

def get_chunk(tree_path, chunk_key):
    key = (tree_path, chunk_key)
    if key not in CACHE:
        chunk = Chunk().from_string(download_chunk(key))
        CACHE[key] = chunk
    return CACHE[key]

#TODO use something more robust like Storage
def put_file_local(key, value):
    path = '{}/{}'.format(*key)
    if not os.path.exists(os.path.dirname(path)):
        os.makedirs(os.path.dirname(path))
    with open(path, 'wb') as f:
        f.write(value)

def read_file_local(key):
    path = '{}/{}'.format(*key)
    if not os.path.exists(path):
        return None
    with open(path, 'rb') as f:
        return f.read()

# The bucket that will be used to list objects.
BUCKET_NAME = 'neuroglancer'
storage = googleapiclient.discovery.build('storage', 'v1')

def put_file_gcs(key, value):
    """
    we want to store all this files
    inside a folder call graph
    /neuroglancer/dataset_name/segmentation_name/graph

    When the octree is created we need to verify that it's
    name correspond with this
    """
    storage.objects().insert(
        bucket=bucket_name, 
        name='{}/{}'.format(*key),
        media_body=value).execute(num_retries=6)

def read_file_gcs(key):
    return storage.objects().get_media(
        bucket=BUCKET_NAME,
        object='{}/{}'.format(*key)).execute(num_retries=6)

def compress(content):
    stringio = StringIO()
    gzip_obj = gzip.GzipFile(mode='wb', fileobj=stringio)
    gzip_obj.write(content)
    gzip_obj.close()
    return stringio.getvalue()

def uncompress(content):
    if not content:
        return content

    stringio = StringIO(content)
    with gzip.GzipFile(mode='rb', fileobj=stringio) as gfile:
        return gfile.read()