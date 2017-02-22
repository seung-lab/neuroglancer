import os
import re 
import sys
import subprocess
import numpy as np
import math

GCLOUD_PROJECT = 'neuromancer-seung-import'
COMMON_STAGING_DIR = './staging/'

def mkdir(path):
  if not os.path.exists(path):
      os.makedirs(path)

  return path

def list_shape(shape, elem=None):
    """create Nd list filled wtih elem. e.g. shape([2,2], 0) => [ [0,0], [0,0] ]"""

    if (len(shape) == 0):
        return []

    def helper(elem, shape, i):
        if len(shape) - 1 == i:
            return [elem] * shape[i]
        return [ helper(elem, shape, i+1) for _ in xrange(shape[i]) ]

    return helper(elem, shape, 0)

def xyzrange(start_vec, end_vec=None, stride_vec=(1,1,1)):
  if end_vec is None:
    end_vec = start_vec
    start_vec = (0,0,0)

  rangeargs = ( (start, end, stride) for start, end, stride in zip(start_vec, end_vec, stride_vec) )
  xyzranges = ( xrange(*arg) for arg in rangeargs )
  return product(*xyzranges)


def format_cloudpath(cloudpath):
  """convert gs://bucket/dataset/layer or /bucket/dataset/layer
                bucket/dataset/layer/
     to: bucket/dataset/layer """

  cloudpath = re.sub(r'^(gs:)?\/+', '', cloudpath)
  cloudpath = re.sub(r'\/+$', '', cloudpath)
  return cloudpath

def cloudpath_to_hierarchy(cloudpath):
	"""Extract bucket, dataset, layer from cloudpath"""
	cloudpath = format_cloudpath(cloudpath)
	return cloudpath.split('/')

def upload_to_gcloud(filenames, cloudpath, headers={}, compress=False):
  
  mkheader = lambda header, content: "-h '{}:{}'".format(header, content)
  headers = [ mkheader(key, content) for key, content in headers.iteritems() if content != '' ]

  # gsutil chokes when you ask it to upload more than about 1500 files at once
  # so we're using streaming mode (-I) to enable it to handle arbitrary numbers of files
  # -m = multithreaded upload, -h = headers

  gsutil_upload_cmd = "gsutil -m {headers} cp -I {compress} -a public-read gs://{cloudpath}".format(
    headers=" ".join(headers),
    compress=('-Z' if compress else ''),
    cloudpath=cloudpath,
  )

  print(gsutil_upload_cmd)

  gcs_pipe = subprocess.Popen([gsutil_upload_cmd], 
    stdin=subprocess.PIPE, 
    stdout=sys.stdout, 
    shell=True
  )

  # shoves filenames into pipe stdin, waits for process to execute, and terminates
  # returns stdout
  gcs_pipe.communicate(input="\n".join(filenames))


def map2(fn, a, b):
    assert(len(a) == len(b))
    
    newarray = np.empty(len(a))

    for i in xrange(len(array)):
        newarray[i] = fn(array[i], maxarray[i])

    return newarray

def max2(a, b):
    return map2(max, a, b)

def min2(a, b):
    return map2(min, a, b)

class Vec3(np.ndarray):
    def __new__(cls, x,y,z):
        return super(Vec3, cls).__new__(cls, shape=(3,), buffer=np.array([x,y,z]), dtype=int)

    @property
    def x(self):
        return self[0]

    @property
    def y(self):
        return self[1]

    @property
    def z(self):
        return self[2]

    def null(self):
        return self.length() <= 10 * np.finfo(np.float32).eps

    def dot(self, vec):
        return (self.x * vec.x) + (self.y * vec.y) + (self.z * vec.z)

    def length(self):
        return math.sqrt(self[0] * self[0] + self[1] * self[1] + self[2] + self[2])

    def rectVolume(self):
        return self[0] * self[1] * self[2]

    def nonzeroDims(self):
        isdim = lambda x: 1 if x > 10 * np.finfo(np.float32).eps else 0
        return reduce(sum, map(isdim, self))

    def __repr__(self):
        return "Vec3({},{},{})".format(self.x, self.y, self.z)

class Bbox(object):

    def __init__(self, a, b):
        self.minpt = Vec3(
            min(a[0], b[0]),
            min(a[1], b[1]),
            min(a[2], b[2])
        )

        self.maxpt = Vec3(
            max(a[0], b[0]),
            max(a[1], b[1]),
            max(a[2], b[2])
        )

    @classmethod
    def from_vec(self, vec):
        return Bbox( (0,0,0), vec )

    def size3(self):
        return Vec3(*(self.maxpt - self.minpt))

    def volume(self):
        return self.size3().rectVolume()

    def center(self):
        return (self.minpt + self.maxpt) / 2.0

    def contains(self, point):
        return (
                point[0] >= self.minpt[0] 
            and point[1] >= self.minpt[1]
            and point[2] >= self.minpt[2] 
            and point[0] <= self.maxpt[0] 
            and point[1] <= self.maxpt[1]
            and point[2] <= self.maxpt[2]
        )

    def containsBbox(self, bbox):
        return self.contains(bbox.minpt) and self.contains(bbox.maxpt)

    def clone(self):
        return Bbox(self.minpt, self.maxpt)

    def __sub__(self, scalar):
        tmp = self.clone()
        tmp.minpt -= scalar
        tmp.maxpt -= scalar
        return tmp

    def __add__(self, scalar):
        tmp = self.clone()
        tmp.minpt += scalar
        tmp.maxpt += scalar
        return tmp

    def __mul__(self, scalar):
        tmp = self.clone()
        tmp.minpt *= scalar
        tmp.maxpt *= scalar
        return tmp

    def __div__(self, scalar):
        tmp = self.clone()
        tmp.minpt /= scalar
        tmp.maxpt /= scalar
        return tmp

    def __repr__(self):
        return "Bbox({},{})".format(self.minpt, self.maxpt)
