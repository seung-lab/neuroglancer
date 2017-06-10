from neuroglancer.pipeline import *
import requests
from reconstruct import *
import sys

class RemoteGraph():
	def __init__(self, address):
		self.address = address
	def subgraph(self, vertices):
		edges=eval(requests.get("{}/1.0/subgraph/{}/".format(self.address, str(vertices).replace(' ',''))).text)
		return make_graph(vertices,edges)

	def add_clique(self, vertices):
		for i in xrange(len(vertices)):
			for j in xrange(i,len(vertices)):
				requests.get("{}/1.0/merge/{},{}/".format(self.address, vertices[i],vertices[j]))
		
	def delete_bipartite(self, vertices1, vertices2):
		for v1 in vertices1:
			for v2 in vertices2:
				requests.get("{}/1.0/split/{},{}/".format(self.address, v1,v2))

def rev(x):
	if type(x) == tuple:
		return tuple(reversed(x))
	else:
		return list(reversed(x))
class Transpose():
	def __init__(self,x):
		self.data = x
	def __getitem__(self,s):
		return np.squeeze(self.data[rev(s)]).T
	def __setitem__(self,s,val):
		self.data[rev(s)]=val.T
	def __setitem_misaligned__(self,s,val):
		self.data.__setitem_misaligned__(rev(s),val.T)


class PrecomputedVolume():
	def __init__(self, d):
		for (k,v) in d.items():
			if type(v)==type(""):
				setattr(self, k, Transpose(Precomputed(Storage(v),fill=True)))
			else:
				setattr(self, k, v)

cx=512
cy=512
cz=64

def relabel(A, offset):
	Z,Y,X=A.shape
	sz,sy,sx = offset

	rx=np.reshape(range(sx, sx+X),[1,1,-1])/cx
	ry=np.reshape(range(sy, sy+Y),[1,-1,1])/cy
	rz=np.reshape(range(sz, sz+Z),[-1,1,1])/cz


	A=A.astype(np.uint64)
	rx=rx.astype(np.uint64)
	ry=ry.astype(np.uint64)
	rz=rz.astype(np.uint64)

	return A + np.left_shift(1,24+32) + np.left_shift(rx,16+32)+np.left_shift(ry,8+32)+np.left_shift(rz,0+32)


def yacn(
			x,
			y,
			z, 
			image_layer="s3://neuroglancer/pinky40_v8/image",
			watershed_layer="s3://neuroglancer/pinky40_v11/watershed", 
			errors_layer="s3://neuroglancer/pinky40_v11/errors",
			trace_layer="s3://neuroglancer/pinky40_v11/flood_filling",
			advice_layer="s3://neuroglancer/pinky40_v11/advice",
			affinities_layer="s3://neuroglancer/pinky40_v11/affinitymap-jnet",
			graph_server="http://seungworkstation1000.princeton.edu:9100",
			ERROR_THRESHOLD=ERROR_THRESHOLD,
			):
	V = PrecomputedVolume(
			{"image": image_layer,
			 "errors": errors_layer,
			 "raw_labels": watershed_layer,
			 "affinities": affinities_layer,
			 "trace": trace_layer,
			 "advice": advice_layer,
			 "G": RemoteGraph(graph_server),
			 "valid": set([]),
			 })
	
	pos=z,y,x
	region = tuple([slice(pos[i]-patch_size[i]/2,pos[i]+patch_size[i]-patch_size[i]/2) for i in range(3)])
	cutout=SubVolume(V,region)
	cutout.raw_labels = relabel(cutout.raw_labels, [pos[i]-patch_size[i]/2 for i in xrange(3)])
	hm = np.zeros(patch_size)
	for i in xrange(3):
		np.maximum(hm,cutout.affinities[i,:,:,:],hm)
	for i in xrange(3):
		np.maximum(hm,np.roll(cutout.affinities[i,:,:,:],1,axis=i))
	cutout.height_map = hm
	#cutout.thickened_raw_labels = cutout.raw_labels * ((cutout.height_map > 0.1).astype(np.uint64))
	cutout.thickened_raw_labels = cutout.raw_labels * ((cutout.height_map > 0.1).astype(np.uint64))


	central_index = tuple([patch_size[i]/2 for i in xrange(3)])

	central_segment = bfs(cutout.G,[cutout.raw_labels[central_index]])

	current_segments = bfs(cutout.G,[cutout.raw_labels[central_index]]+cutout.local_errors(threshold=ERROR_THRESHOLD))

	cutout.mask=misc_utils.indicator(cutout.thickened_raw_labels,current_segments)
	cutout.central_supervoxel = misc_utils.indicator(cutout.thickened_raw_labels,[cutout.raw_labels[central_index]])
	cutout.current_object


	unique_list = cutout.central_unique_list

	cutout.traced = reconstruct_utils.trace_daemon(cutout.image, cutout.mask, cutout.central_supervoxel)

	traced_list = measurements.mean(cutout.traced, cutout.raw_labels, unique_list)
	current_list = measurements.mean(cutout.current_object, cutout.raw_labels, unique_list)

	rounded_positive = [unique_list[i] for i in xrange(len(unique_list)) if traced_list[i] > 0.5]
	rounded_negative = [unique_list[i] for i in xrange(len(unique_list)) if traced_list[i] <= 0.5]

	V.G.add_clique(rounded_positive)
	V.G.delete_bipartite(rounded_positive, rounded_negative)

	V.trace.__setitem_misaligned__(region, np.expand_dims(cutout.traced,axis=0))
	V.advice.__setitem_misaligned__(region, np.expand_dims(cutout.mask,axis=0))
	#V.advice.__setitem_misaligned__(region, np.expand_dims(cutout.thickened_raw_labels,axis=0))

	print "done"

from neuroglancer.pipeline import *
import neuroglancer.simple_task_queue.task_queue as task_queue
import time

tq=task_queue.TaskQueue("http://50.16.149.198:8080/1.0")
while True:
	try:
		task = tq.lease(60)
		print task.payload
		print eval(task.payload)
		tq.delete(task.name)
	except task_queue.QueueEmptyException as e:
		sys.stdout.write('.')
		sys.stdout.flush()
		time.sleep(1)
	except Exception as e:
		print e
