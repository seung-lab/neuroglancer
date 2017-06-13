from __future__ import absolute_import

import itertools
import math

from . import Runner
from .dataset import MultiDataset, dataset_path
from .error_correction_experiment import ErrorCorrectionExperiment
from . import enviroment

def length_scale(x):
    return -1 if x == 0 else math.log(abs(x))

def valid_pair(x, y, strict=False):
    return x == 0 or y == 0 or (
        (not strict or length_scale(x) >= length_scale(y)) and abs(
            length_scale(x) - length_scale(y)) <= math.log(3.1))

def valid_offset(x):
    return x > (0,0,0) and \
    valid_pair(4 * x[0], x[1], strict=True) and \
    valid_pair(4 * x[0], x[2], strict=True) and \
    valid_pair(x[1],x[2])


dataset = MultiDataset(
    directories=[   
        dataset_path.get_path("1_1_1"), #0
        dataset_path.get_path("1_2_1"), #1 
        dataset_path.get_path("1_3_1"), #2
        dataset_path.get_path("2_1_1"), #3
        dataset_path.get_path("2_2_1"), #4
        dataset_path.get_path("2_3_1"), #5
        dataset_path.get_path("3_1_1"), #6
    ],
    types={
        "image": "image.h5",
        "machine_labels": "lzf_mean_agg_tr.h5",
        "human_labels": "lzf_proofread.h5",
        "samples": "padded_valid_samples.h5",
        "valid": "valid.h5"
    },
    train_vols=[0,1,2,3,4,5],
    test_vols=[6],
    patch_size=(33,318,318))

offsets= filter(valid_offset, itertools.product(
        [-3, -1, 0, 1, 3],
        [-27, -9, 0, 9, 27],
        [-27, -9, 0, 9, 27]))

experiment = ErrorCorrectionExperiment(
    dataset=dataset,
    nvec_labels= 6,
    maxn= 40,
    offsets=offsets
)

runner = Runner(experiment,   
                devices= enviroment.get_device_list()
               )

runner.train(n_steps=1000000,
             long_summary_test_interval=15,
             checkpoint_interval=3000
             )