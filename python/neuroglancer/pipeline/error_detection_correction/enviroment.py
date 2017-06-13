import logging
import os

# the default is 64gb we need to use more memory
# undocumented feature
# we found this by searching in the code for a memory limit
os.environ['TF_CUDA_HOST_MEM_LIMIT_IN_MB'] = '200000'
os.environ["LD_LIBRARY_PATH"] = "/usr/local/cuda/extras/CUPTI/lib64/"

from tensorflow.python.client import device_lib

# os.environ["CUDA_VISIBLE_DEVICES"]="0" # this doesn't work
logging.getLogger().setLevel(logging.DEBUG)


def get_available_gpus():
    local_device_protos = device_lib.list_local_devices()
    return [x.name for x in local_device_protos if x.device_type == 'GPU']

def get_device_list():
    gpus = get_available_gpus()
    if len(gpus) > 0:
        return gpus
    else:
        return ["/cpu:0"]
