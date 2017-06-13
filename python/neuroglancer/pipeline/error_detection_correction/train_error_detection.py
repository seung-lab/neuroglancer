from ext.third_party.yacn.nets.error_detection_experiment import ErrorDetectionExperiment
from .dataset import MultiDataset, dataset_path
from ext.third_party.yacn.nets.error_detection_estimator import patch_size_suggestions

 
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
        "machine_labels": "lzf_mean_agg_tr.h5",
        "human_labels": "lzf_proofread.h5",
        "image": "image.h5",
        "samples": "padded_valid_samples.h5",
    },
    train_vols=[0,1,2,3,4,5],
    test_vols=[6],
    patch_size=patch_size)

experiment = ErrorDetectionExperiment(
    devices=enviroment.get_device_list(), #['/gpu:0'], #,
    patch_size=tuple(patch_size_suggestions([2,3,3])[0]),
    dataset=dataset

    )

Runner(experiment).train()
