
from intern.remote.boss import BossRemote
from intern.resource.boss.resource import *
import numpy as np

from neuroglancer.pipeline.secrets import boss_credentials
from volumes import Volume, VolumeCutout, generate_slices, EmptyVolumeException

ExtractedPath = namedtuple('ExtractedPath', 
  ('protocol','collection', 'experiment', 'channel')
)

class BossVolume(Volume):
  """
  Represents an interface to a dataset layer at a given
  mip level. You can use it to send and receive data from neuroglancer
  datasets on theboss.io.

  Required:
    cloudpath: Path to the dataset layer. This should match storage's supported
      providers.

      e.g. The Boss: boss://collection/experiment/channel/
           
  Optional:
    mip: (int) Which level of downsampling to read to/write from. 0 is the highest resolution.
    bounded: (bool) If a region outside of volume bounds is accessed:
        True: 
          - Throw an error
          - Negative indicies have the normal python meaning
        False: 
          - Fill the region with black (useful for e.g. marching cubes's 1px boundary)
          - Negative indicies refer to cartesian space
    fill_missing: (bool) If a file inside volume bounds is unable to be fetched:
        True: Use a block of zeros
        False: Throw an error
    info: (dict) in lieu of fetching a neuroglancer info file, use this provided one.
            This is useful when creating new datasets.
  """
  def __init__(self, cloudpath, mip=0, bounded=True, fill_missing=False, info=None):
    super(self.__class__, self).__init__()

    extract = CloudVolume.extract_path(cloudpath)

    self._protocol = extract.protocol
    self._bucket = extract.collection

    # You can access these two with properties
    self._dataset_name = extract.experiment
    self._layer = extract.channel

    self.mip = mip
    self.bounded = bounded
    self.fill_missing = fill_missing

    self.num_channels = 1
    self.dtype = 'uint8'

  @classmethod
  def extract_path(cls, cloudpath):
    """cloudpath: e.g. gs://neuroglancer/DATASET/LAYER/info or s3://..."""
    match = re.match(r'^(boss)://([/\d\w_\.\-]+)/([\d\w_\.\-]+)/([\d\w_\.\-]+)/?', cloudpath)
    return ExtractedPath(*match.groups())

  def __getitem__(self, slices):
    maxsize = list(self.bounds.maxpt) + [ self.num_channels ]
    minsize = list(self.bounds.minpt) + [ 0 ]

    slices = generate_slices(slices, minsize, maxsize, bounded=self.bounded)
    channel_slice = slices.pop()

    minpt = Vec(*[ slc.start for slc in slices ])
    maxpt = Vec(*[ slc.stop for slc in slices ]) 
    steps = Vec(*[ slc.step for slc in slices ])

    requested_bbox = Bbox(minpt, maxpt)
    cutout = self._cutout(requested_bbox, steps, channel_slice)

    if self.bounded:
      return cutout
    elif cutout.bounds == requested_bbox:
      return cutout

    # This section below covers the case where the requested volume is bigger
    # than the dataset volume and the bounds guards have been switched 
    # off. This is useful for Marching Cubes where a 1px excess boundary
    # is needed.
    shape = list(requested_bbox.size3()) + [ cutout.shape[3] ]
    renderbuffer = np.zeros(shape=shape, dtype=self.dtype)
    lp = cutout.bounds.minpt - requested_bbox.minpt
    hp = lp + cutout.bounds.size3()
    renderbuffer[ lp.x:hp.x, lp.y:hp.y, lp.z:hp.z, : ] = cutout 
    return VolumeCutout.from_volume(self, renderbuffer, requested_bbox)

  def _cutout(self, requested_bbox, steps, channel_slice=slice(None)):
    realized_bbox = Bbox.clamp(realized_bbox, self.bounds)

    x_rng = [ realized_bbox.minpt.x, realized_bbox.maxpt.x + 1 ]
    y_rng = [ realized_bbox.minpt.y, realized_bbox.maxpt.y + 1 ]
    z_rng = [ realized_bbox.minpt.z, realized_bbox.maxpt.z + 1 ]

    chan = ChannelResource(
      self._bucket, self._dataset_name, self._layer, 'image', datatype=self.dtype)

    rmt = BossRemote(boss_credentials)
    img3d = rmt.get_cutout(chan, self.mip, x_rng, y_rng, z_rng).T
    return VolumeCutout.from_volume(self, renderbuffer, realized_bbox)
