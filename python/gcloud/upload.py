import parseargs
import multiprocessing
import images
import meshes

parser = argparse.ArgumentParser(description='Upload hdf5s to GCloud in a Neuroglancer readable format.')
parser.add_argument('--directory', dest='dir_path', action='store',
                default=None, metavar='IMAGE_FILES_PATH',
                help='Filepath to stacks of hdf5s')

parser.add_argument('--dataset', dest='dataset_name', action='store',
                              metavar='DATASET_NAME',
                help='Name of dataset to store in gcloud', required=True)

parser.add_argument('--bucket', dest='bucket_name', action='store',
                              metavar='BUCKET_NAME',
                help='Name of gcloud bucket to use', required=True)  

parser.add_argument('--resolution', dest='resolution', action='store',
                            metavar='X,Y,Z',
              help='X,Y,Z comma seperated anisotropy. e.g. 6,6,30 meaning 6nm x 6nm x 30nm', required=True)  

args = parser.parse_args()
resolution = map(int, args.resolution.split(','))

N_cpus = multiprocessing.cpu_count()
pool = multiprocessing.Pool(N_cpus)

def upload_channel(path):
	images.process_hdf5(
      filename=path,
      dataset=args.dataset_name,
      bucket_name=args.bucket_name,
      resolution=resolution,
      layer='image'
    )

def upload_segmentation(path):
	images.process_hdf5(
      filename=path,
      dataset=args.dataset_name,
      bucket_name=args.bucket_name,
      resolution=resolution,
      layer='segmentation'
    )

def upload_meshes(path, chunk):
	meshes.process_hdf5(
		filename=path, 
		chunk=chunk,
		dataset=args.dataset_name,
		bucket=args.bucket_name,
		resolution=resolution
	)

pool.map(upload_channel, [])
pool.map(upload_segmentation, [])
pool.map(upload_meshes, [])
