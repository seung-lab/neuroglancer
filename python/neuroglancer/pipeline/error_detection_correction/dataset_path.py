import os

paths = {'1_1_1':'seungmount/Omni/TracerTasks/pinky/proofreading/chunk_14977-17024_27265-29312_4003-4258.omni.files/',
         '1_2_1':'seungmount/Omni/TracerTasks/pinky/proofreading/chunk_14977-17024_28801-30848_4003-4258.omni.files/',
         '1_3_1':'seungmount/Omni/TracerTasks/pinky/proofreading/chunk_14977-17024_30337-32384_4003-4258.omni.files/',
         '2_1_1':'seungmount/Omni/TracerTasks/pinky/proofreading/chunk_16513-18560_27265-29312_4003-4258.omni.files/',
         '2_2_1':'seungmount/Omni/TracerTasks/pinky/proofreading/chunk_16513-18560_28801-30848_4003-4258.omni.files/',
         '2_3_1':'seungmount/Omni/TracerTasks/pinky/proofreading/chunk_16513-18560_30337-32384_4003-4258.omni.files/',
         '3_1_1':'seungmount/Omni/TracerTasks/pinky/proofreading/chunk_18049-20096_27265-29312_4003-4258.omni.files/',
         '3_2_1':'seungmount/Omni/TracerTasks/pinky/proofreading/chunk_18049-20096_28801-30848_4003-4258.omni.files/',
         '3_3_1':'seungmount/Omni/TracerTasks/pinky/proofreading/chunk_18049-20096_30337-32384_4003-4258.omni.files/',
        'golden':'seungmount/Omni/TracerTasks/pinky/proofreading/chunk_19585-21632_22657-24704_4003-4258.omni.files/'}

def get_path( dataset_name ):
    return os.path.join(os.path.expanduser("~"), paths[dataset_name])