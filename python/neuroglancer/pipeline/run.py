from glob import glob
import sys
import os

from task_yacn import DiscriminateTask, RegionGraphTask

basepath = 'file:///usr/people/it2/seungmount/research/sergiy/overlap/'
dataset = 'golden_crop_2'

for seg in glob('/usr/people/it2/seungmount/research/sergiy/overlap/final_seg_ng/'+sys.argv[1]):
    layer = os.path.basename(seg)
    os.mkdir('/usr/people/it2/seungmount/research/sergiy/overlap/errors/'+layer)
    with open('/usr/people/it2/seungmount/research/sergiy/overlap/errors/'+layer+'/info', 'w') as f:
        f.write('{"num_channels": 1, "type": "image", "data_type": "float32", "scales": [{"encoding": "raw", "chunk_sizes": [[64, 64, 64]], "key": "4_4_40", "resolution": [4, 4, 40], "voxel_offset": [0, 0, 0], "size": [1918,1918,246]}]}')

    DiscriminateTask(
        chunk_position='0-1918_0-1918_0-246',
        crop_position='0-1918_0-1918_0-246',
        yacn_layer=basepath+'yacn',
        segmentation_layer=basepath+'final_seg_ng/'+ layer,
        image_layer=basepath+'images_ng/golden',
        errors_layer=basepath+'errors/'+ layer).execute()
