from neuroglancer._mesher import Mesher
from storage import Storage
from task_queue import MockTaskQueue, TaskQueue, RegisteredTask
from tasks import *
from tasks_watershed import WatershedTask
from cloudvolume import CloudVolume, EmptyVolumeException

def Precomputed(storage, scale_idx=0, fill=False):
  """Shim to provide backwards compatibility with Precomputed."""
  return CloudVolume(storage.layer_path, mip=scale_idx, fill_missing=fill)