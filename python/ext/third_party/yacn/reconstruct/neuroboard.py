from StringIO import StringIO
import webbrowser

import requests
from scipy.misc import imread
import numpy as np
from sklearn.decomposition import PCA
import neuroglancer

URL = 'http://seungworkstation1000.princeton.edu'
viewer = neuroglancer.Viewer()
neuroglancer.set_static_content_source(url='http://localhost:8080')

runs = requests.get(URL+'/data/runs').json()
first_run_key = runs.keys()[0]
first_run = runs[first_run_key]
images =  first_run['images']

def download_image(image_url):
    index = 0  # sometimes 3 #not sure why
    tag = image_url.replace('/','%2F')
    full_url = URL + '/data/individualImage?index={}&tag={}&run={}'.format(
        index,tag, first_run_key)
    r = requests.get(full_url)
    assert r.status_code == 200

    img = imread(StringIO(r.content))
    height = img.shape[1]/img.shape[0]
    img3d = np.zeros(shape=(img.shape[0],img.shape[0], height), dtype=img.dtype)
    for z in range(height):
        img3d[:,:,z] = img[:,z*img.shape[0]: (z+1)*img.shape[0]]
        
    return img3d.T

def stack_vector_labels():
    combined = np.zeros(shape=(33,318,318,6), dtype=np.uint8)
    for image_url in images:
        if 'vector_labels' in image_url:
            img = download_image(image_url)
            img_idx = int(image_url[-1])
            combined[:,:,:, img_idx] = img
    return combined

def reduce_dimensions(stack4d):
    """
    Somehow checkerboard artifacts get amplified by PCA
    This will be especially true for the results of the single-object vector labels
    network since there is no constraint on the background objects
    The network can write whatever it wants in the background as long as it is far 
    from the central label
    """
    pca = PCA(n_components=3)
    transformed = pca.fit_transform(stack4d.reshape(-1,stack4d.shape[-1]))

    # cast as uint8
    transformed += abs(transformed.min())
    transformed *= 255.0 / transformed.max()
    transformed = transformed.astype(np.uint8)

    # reshape
    new_shape = stack4d.shape[:-1] + (3,)
    transformed = transformed.reshape(*new_shape)

    return transformed.transpose((3,0,1,2))

def display_vector_labels():
    vl = stack_vector_labels()
    vl = reduce_dimensions(vl)
    viewer.add(volume_type='image', data=vl,
               name='vector_labels', voxel_size=[6, 6, 40],
                shader="""
                void main() { emitRGB( 
                                vec3(toNormalized(getDataValue(0)), 
                                     toNormalized(getDataValue(1)),
                                     toNormalized(getDataValue(2))));
                }
                """)


def display_em():
    viewer.add(volume_type='image', data=download_image('optimize/image/image/0'),
               name='image', voxel_size=[6, 6, 40])

def display_desired_output():
    viewer.add(volume_type='segmentation', data=download_image('optimize/truth/image/0'),
               name='desired', voxel_size=[6, 6, 40])

display_em()
display_vector_labels()
display_desired_output()
webbrowser.open_new_tab(viewer.get_viewer_url()) 