from __future__ import print_function

from collections import namedtuple
from cStringIO import StringIO
import Queue
import os
import re
import threading
import time
import signal
from functools import partial

from glob import glob
from google.cloud.storage import Client
import boto 
from boto.s3.connection import S3Connection
import gzip

from neuroglancer.pipeline.secrets import PROJECT_NAME, google_credentials_path, aws_credentials

class Storage(object):
    """
    Probably rather sooner that later we will have to store datasets in S3.
    The idea is to modify this class constructor to probably take a path of 
    the problem protocol://bucket_name/dataset_name/layer_name where protocol
    can be s3, gs or file.

    file:// would be useful for when the in-memory python datasource uses too much RAM,
    or possible for writing unit tests.

    This should be the only way to interact with files, either for anyone of the protocols
    """
    gzip_magic_numbers = [0x1f,0x8b]
    path_regex = re.compile(r'^(gs|file|s3)://(/?.*?)/(.*/)?([^//]+)/([^//]+)/?$')
    ExtractedPath = namedtuple('ExtractedPath',
        ['protocol','bucket_name','dataset_path','dataset_name','layer_name'])

    def __init__(self, layer_path='', n_threads=20):

        self._layer_path = layer_path
        self._path = self.extract_path(layer_path)
        self._n_threads = n_threads

        if self._path.protocol == 'file':
            self._interface_cls = FileInterface
        elif self._path.protocol == 'gs':
            self._interface_cls = GoogleCloudStorageInterface
        elif self._path.protocol == 's3':
            self._interface_cls = S3Interface

        self._interface = self._interface_cls(self._path)

        self._queue = Queue.Queue(maxsize=0) # infinite size
        self._threads = ()
        self._terminate = threading.Event()

        self.start_threads(n_threads)

    @property
    def layer_path(self):
        return self._layer_path

    def get_path_to_file(self, file_path):
        return os.path.join(self._layer_path, file_path)

    def start_threads(self, n_threads):
        if n_threads == len(self._threads):
            return self

        self._terminate.set()
        self._terminate = threading.Event()

        threads = []
        for _ in xrange(n_threads):
            worker = threading.Thread(
                target=self._consume_queue, 
                args=(self._terminate,)
            )
            worker.daemon = True
            worker.start()
            threads.append(worker)

        self._threads = tuple(threads)
        return self

    def are_threads_alive(self):
        return any(map(lambda t: t.isAlive(), self._threads))

    def kill_threads(self):
        self._terminate.set()
        while self.are_threads_alive():
          time.sleep(0.1)

        self._threads = ()
        return self

    def _consume_queue(self, terminate_evt):
        interface = self._interface_cls(self._path)

        while not terminate_evt.is_set():
            try:
                fn = self._queue.get(block=True, timeout=1)
            except Queue.Empty:
                continue # periodically check if the thread is supposed to die

            try:
                fn(interface)
            except Exception as err:
                print(err)
            finally:
                self._queue.task_done()

    @classmethod
    def extract_path(cls, layer_path):
        match = cls.path_regex.match(layer_path)
        if not match:
            return None
        else:
            return cls.ExtractedPath(*match.groups())

    def put_file(self, file_path, content, content_type=None, compress=False):
        """ 
        Args:
            filename (string): it can contains folders
            content (string): binary data to save
        """
        return self.put_files([ (file_path, content) ], content_type, compress)

    def put_files(self, files, content_type=None, compress=False):
        """
        Put lots of files at once and get a nice progress bar. It'll also wait
        for the upload to complete, just like get_files.

        Required:
            files: [ (filepath, content), .... ]
        """
        def put_file(path, content, interface):
            interface.put_file(path, content, content_type, compress)

        for path, content in files:
            if compress:
                content = self._compress(content)

            uploadfn = partial(put_file, path, content)

            if len(self._threads):
                self._queue.put(uploadfn, block=True)
            else:
                uploadfn(self._interface)

        self.wait()

        return self

    def get_file(self, file_path):
        # Create get_files does uses threading to speed up downloading

        content, decompress = self._interface.get_file(file_path)
        if content and decompress != False:
            content = self._maybe_uncompress(content)
        return content

    def get_files(self, file_paths):
        """
        returns a list of files faster by using threads
        """

        results = []

        def get_file_thunk(path, interface):
            result = error = None 

            try:
                result = interface.get_file(path)
            except Exception as err:
                error = err
                print(err)
            
            content, decompress = result
            if content and decompress:
                content = self._maybe_uncompress(content)

            results.append({
                "filename": path,
                "content": content,
                "error": error,
            })

        for path in file_paths:
            if len(self._threads):
                self._queue.put(partial(get_file_thunk, path), block=True)
            else:
                get_file_thunk(path, self._interface)

        self.wait()
        return results

    def _maybe_uncompress(self, content):
        """ Uncompression is applied if the first to bytes matches with
            the gzip magic numbers. 
            There is once chance in 65536 that a file that is not gzipped will
            be ungzipped. That's why is better to set uncompress to False in
            get file.
        """
        if [ord(byte) for byte in content[:2]] == self.gzip_magic_numbers:
            return self._uncompress(content)
        return content

    @staticmethod
    def _compress(content):
        stringio = StringIO()
        gzip_obj = gzip.GzipFile(mode='wb', fileobj=stringio)
        gzip_obj.write(content)
        gzip_obj.close()
        return stringio.getvalue()

    @staticmethod
    def _uncompress(content):
        stringio = StringIO(content)
        with gzip.GzipFile(mode='rb', fileobj=stringio) as gfile:
            return gfile.read()

    def list_files(self, prefix=""):
        for f in self._interface.list_files(prefix):
            yield f

    def wait(self):
        if len(self._threads):
            self._queue.join()

    def __del__(self):
        self.kill_threads()
        self._interface.release_connection()

    def __enter__(self):
        self.start_threads(self._n_threads)
        return self

    def __exit__(self, exception_type, exception_value, traceback):
        self.wait()
        self.kill_threads()

class FileInterface(object):

    def __init__(self, path):
        self._path = path

    def get_path_to_file(self, file_path):
        
        clean = filter(None,[self._path.bucket_name,
                             self._path.dataset_path,
                             self._path.dataset_name,
                             self._path.layer_name,
                             file_path])
        return  os.path.join(*clean)

    def put_file(self, file_path, content, compress):
        path = self.get_path_to_file(file_path)
        try:
            with open(path, 'wb') as f:
                f.write(content)
        except IOError:
            try: `
                # a raise condition is possible
                # where the first try fails to create the file
                # because the folder that contains it doesn't exists
                # but when we try to create here, some other thread
                # already created this folder
                os.makedirs(os.path.dirname(path))
            except OSError:
                pass

    def get_file(self, file_path):
        path = self.get_path_to_file(file_path) 
        try:
            with open(path, 'rb') as f:
                return f.read(), None
        except IOError:
            return None, False

    def list_files(self, prefix):
        layer_path = self.get_path_to_file("")        
        path = os.path.join(layer_path, prefix)
        path += "*"

        for file_path in glob(path):
            if not os.path.isfile(file_path):
                continue
            yield os.path.basename(file_path)

class GoogleCloudStorageInterface(object):
    def __init__(self, path):
        self._path = path
        client = Client.from_service_account_json(
            google_credentials_path,
            project=PROJECT_NAME)
        self._bucket = client.get_bucket(self._path.bucket_name)

    def get_path_to_file(self, file_path):
        clean = filter(None,[self._path.dataset_path,
                             self._path.dataset_name,
                             self._path.layer_name,
                             file_path])
        return  os.path.join(*clean)


    def put_file(self, file_path, content, compress):
        """ 
        TODO set the content-encoding to
        gzip in case of compression.
        """
        key = self.get_path_to_file(file_path)
        blob = self._bucket.blob( key )
        blob.upload_from_string(content)
        if compress:
            blob.content_encoding = "gzip"
            blob.patch()

    def get_file(self, file_path):
        key = self.get_path_to_file(file_path)
        blob = self._bucket.get_blob( key )
        if not blob:
            return None, False
        return blob.download_as_string(), blob.content_encoding == "gzip"

    def list_files(self, prefix):
        """
        if there is no trailing slice we are looking for files with that prefix
        """
        layer_path = self.get_path_to_file("")        
        path = os.path.join(layer_path, prefix)
        for blob in self._bucket.list_blobs(prefix=path):
            filename =  os.path.basename(prefix) + blob.name[len(path):]
            if '/' not in filename:
                yield filename

class S3Interface(object):

    def __init__(self, path):
        self._path = path
        conn = S3Connection(aws_credentials['AWS_ACCESS_KEY_ID'],
                            aws_credentials['AWS_SECRET_ACCESS_KEY'])
        self._bucket = conn.get_bucket(self._path.bucket_name)

    def get_path_to_file(self, file_path):
        clean = filter(None,[self._path.dataset_path,
                             self._path.dataset_name,
                             self._path.layer_name,
                             file_path])
        return  os.path.join(*clean)

    def put_file(self, file_path, content, compress):
        k = boto.s3.key.Key(self._bucket)
        k.key = self.get_path_to_file(file_path)
        if compress:
            k.set_contents_from_string(
                content,
                headers={"Content-Encoding": "gzip"})
        else:
            k.set_contents_from_string(content)
            
    def get_file(self, file_path):
        """
            There are many types of execptions which can get raised
            from this method. We want to make sure we only return
            None when the file doesn't exist.

            TODO maybe implement retry in case of timeouts. 
        """
        k = boto.s3.key.Key(self._bucket)
        k.key = self.get_path_to_file(file_path)
        try:
            return k.get_contents_as_string(), k.content_encoding == "gzip"
        except boto.exception.S3ResponseError as e:
            if e.error_code == 'NoSuchKey':
                return None, False
            else:
                raise e
    def list_files(self, prefix):
        """
        if there is no trailing slice we are looking for files with that prefix
        """
        from tqdm import tqdm
        layer_path = self.get_path_to_file("")        
        path = os.path.join(layer_path, prefix)
        for blob in self._bucket.list(prefix=path):
            filename =  os.path.basename(prefix) + blob.name[len(path):]
            if '/' not in filename:
                yield filename