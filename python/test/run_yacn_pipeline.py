import shutil
import numpy as np
import h5py
from itertools import product
import random
import traceback

from neuroglancer.ingest.volumes.volumes import HDF5Volume
from neuroglancer.pipeline import Precomputed, Storage, RegionGraphTask, DiscriminateTask, FloodFillingTask, DumbsampleTask
from neuroglancer.pipeline import EmptyVolumeException
from neuroglancer.pipeline.task_creation import (upload_build_chunks, create_info_file_from_build,
	create_ingest_task, MockTaskQueue)
from neuroglancer.pipeline.task_queue import TaskQueue
from neuroglancer.pipeline import logger
from neuroglancer.pipeline import Storage, Precomputed, RegisteredTask
import time
import re
import os

#The chunks corners are evenly spaced at intervals of chunk_size, starting at offset.
def parse_chunk_position(chunk_position):
	match = re.match(r'^(\d+)-(\d+)_(\d+)-(\d+)_(\d+)-(\d+)$', chunk_position)
	(xmin, xmax,
	 ymin, ymax,
	 zmin, zmax) = map(int, match.groups())
	return Chunk([xmin+padding[0], ymin+padding[1], zmin+padding[2]])

class Chunk():
	def __init__(self, corner):
		global full_slices
		global chunk_size
		global padding
		self.corner=corner
		self.slices = [slice(c,min(c+x,f.stop)) for c,x,f in zip(corner, chunk_size, full_slices)]
		self.padded_slices = [slice(x.start-p,x.stop+p) for x,p in zip(self.slices, padding)]
	
	def __str__(self):
		return "{}-{}_{}-{}_{}-{}".format(self.padded_slices[0].start, self.padded_slices[0].stop,
			self.padded_slices[1].start, self.padded_slices[1].stop,
			self.padded_slices[2].start, self.padded_slices[2].stop)
	
	def crop_position(self):
		return "{}-{}_{}-{}_{}-{}".format(padding[0], self.slices[0].stop - self.slices[0].start + padding[0],
			padding[1], self.slices[1].stop - self.slices[1].start + padding[1],
			padding[2], self.slices[2].stop - self.slices[2].start + padding[2])
	
	def absolute_crop_position(self):
		return "{}-{}_{}-{}_{}-{}".format(self.slices[0].start, self.slices[0].stop,
			self.slices[1].start, self.slices[1].stop,
			self.slices[2].start, self.slices[2].stop)

	
	def __eq__(self, other):
		return tuple(self.corner) == tuple(other.corner)

	def __le__(self, other):
		return tuple(self.corner).__le__(tuple(other.corner))
	def __ge__(self, other):
		return tuple(self.corner).__ge__(tuple(other.corner))
	def __ne__(self, other):
		return tuple(self.corner).__ne__(tuple(other.corner))
	def __lt__(self, other):
		return tuple(self.corner).__lt__(tuple(other.corner))
	def __gt__(self, other):
		return tuple(self.corner).__gt__(tuple(other.corner))

	def __hash__(self):
		return hash(tuple(self.corner))

	def neighbours(self):
		for i in [-1,0,1]:
			for j in [-1,0,1]:
				for k in [-1,0,1]:
					c = Chunk([self.corner[0]+i*chunk_size[0], 
							self.corner[1]+j*chunk_size[1],
							self.corner[2]+k*chunk_size[2]])
					if is_valid(c):
						yield c

def is_valid(chunk):
	return all([full_slices[i].start <= chunk.corner[i] < full_slices[i].stop for i in xrange(3)])

chunk_size=[4*192,4*192,4*16]
#chunk_size=[192,192,16]
padding=[192,192,16]
offset=[10240+192, 7680+192, 0+16]
end = [65015-192,43715-192,1002-16]

full_slices=[slice(i,o) for i,o in zip(offset, end)]
import math
print "Full slices {}".format(full_slices)
print "Voxels {}".format([x.stop-x.start for x in full_slices])
print "Chunks {}".format([1.0*(x.stop-x.start)/c for x,c in zip(full_slices, chunk_size)])

#We want to iterate in x-fast order (the opposite of lexicographic)
#This is because keys are stored in S3 in lexicographic order, and we
#want to distribute reads/writes between different machines
chunks = list(map(lambda corner: Chunk(list(reversed(corner))),product(*reversed([xrange(f.start, f.stop, c) for f,c in zip(full_slices,chunk_size)]))))
for c in chunks:
	pass
	#print (c.slices, c.padded_slices)

def check_bucket(prefix, suffix="", mode="outer"):
	import boto3
	s3=boto3.resource('s3')
	bucket=s3.Bucket('neuroglancer')
	keys = set([x.key for x in bucket.objects.filter(Prefix=prefix)])
	print len(keys)
	i=0
	for k,chunk in enumerate(chunks):
		if k % 1000 == 0:
			print k
		if mode == "outer":
			key = prefix + str(chunk) + suffix
		elif mode == "inner":
			key = prefix + chunk.absolute_crop_position() + suffix
		else:
			assert False
		if key not in keys:
			i=i+1
			print "{} missing {}".format(i,key)

class LockException(Exception):
	def __init__(self, key, subscriber, current_subscriber):
		self.key=key
		self.subscriber=subscriber
		self.current_subscriber=current_subscriber
class DoneEnqueuingException(Exception):
	pass

locks = {}
def lock(chunk, subscriber):
	if chunk in locks and locks[chunk] != subscriber:
		raise LockException(chunk,subscriber,locks[chunk])
	locks[chunk]=subscriber

def unlock(chunk, subscriber):
	assert locks[chunk] == subscriber
	locks.pop(chunk)

def atomic_lock(chunks, subscriber):
	chunks = sorted(chunks)
	for i in xrange(len(chunks)):
		try:
			lock(chunks[i], subscriber)
		except LockException as e:
			for j in xrange(i):
				unlock(chunks[j], subscriber)
			raise e

def atomic_unlock(chunks, subscriber):
	chunks = sorted(chunks)
	for i in xrange(len(chunks)):
		unlock(chunks[i], subscriber)

def jailbreak():
	print "Jailbreak!"
	global locks
	locks = {}

class ReleaseLocksTask(RegisteredTask):
	def __init__(self, chunk_position):
		super(ReleaseLocksTask, self).__init__(chunk_position)
		self.chunk_position = chunk_position
	def execute(self):
		global not_started
		chunk=parse_chunk_position(self.chunk_position)
		#assert chunk not in not_started
		atomic_unlock(list(chunk.neighbours()), chunk)


dataset_path = "s3://neuroglancer/pinky40_v11/"
dataset_path2 = "s3://neuroglancer/pinky40_v10/"
def stage1_enqueue(q):
	import time
	q.purge()
	for i,chunk in enumerate(chunks):
		print chunk
		print i
		t = RegionGraphTask(
			chunk_position=str(chunk), 
			crop_position=chunk.crop_position(),
			watershed_layer=dataset_path+'watershed', 
			segmentation_layer="gs://neuroglancer/pinky40_v11/mean_0.27_segmentation", 
			yacn_layer=dataset_path+'yacn', 
			affinities_layer=dataset_path+'affinitymap-jnet'
		)
		print t
		q.insert(t)
	q.wait()

def stage2_enqueue(q):
	import json
	data = {
	   "num_channels":1,
	   "type":"image",
	   "data_type":"float32",
	   "scales":[
		  {
			 "encoding":"raw",
			 "chunk_sizes":[
				[
				   192,
				   192,
				   16
				]
			 ],
			 "key":"4_4_40",
			 "resolution":[
				4,
				4,
				40
			 ],
			 "voxel_offset":[
				full_slices[0].start,
				full_slices[1].start,
				full_slices[2].start
			 ],
			 "size":[
				full_slices[0].stop-full_slices[0].start,
				full_slices[1].stop-full_slices[1].start,
				full_slices[2].stop-full_slices[2].start
			 ]
		  }
	   ]
	}
	info=json.dumps(data, indent=4, sort_keys=True, separators=(',', ': '), ensure_ascii=True)
	s=Storage(dataset_path+'errors')
	s.put_file(file_path=('info'), content=info )
	s.wait()

	print len(chunks)
	for chunk in chunks:
		t = DiscriminateTask(
				chunk_position=str(chunk), 
				crop_position=chunk.crop_position(),
				image_layer=dataset_path2+"image",
				segmentation_layer="gs://neuroglancer/pinky40_v11/mean_0.27_segmentation", 
				errors_layer=dataset_path+'errors',
				yacn_layer=dataset_path+'yacn')
		print t
		q.insert(t)
	q.wait()

not_started = set(chunks)
log_file="finished_tasks"
def restore():
	for line in open(log_file):
		chunk = parse_chunk_position(line.strip())
		not_started.remove(chunk)
		print "Finished " + str(chunk)
	print len(not_started)
	raw_input()
def stage3_enqueue(q):
	import random
	q.purge()
	restore()
	global not_started
	while True:
		try:
			if len(not_started)==0:
				raise DoneEnqueuingException()
			chunk = random.sample(not_started,1)[0]

			assert chunk in not_started
			atomic_lock(list(chunk.neighbours()), chunk)
			not_started.remove(chunk)
			t=FloodFillingTask(
					chunk_position=str(chunk), 
					neighbours_chunk_position=reduce(lambda x,y: x + " " + y, map(str, chunk.neighbours()),""),
					crop_position=chunk.crop_position(),
					image_layer=dataset_path2+'image',
					watershed_layer=dataset_path+'watershed',
					errors_layer=dataset_path+'errors',
					residual_errors_layer=dataset_path+'residual_errors',
					yacn_layer=dataset_path+'yacn',
					skip_threshold=0.9,
					)
			print t
			q.insert(t)
		except (LockException, DoneEnqueuingException) as e:
			#print "Lock failed: " + str(e.key) + " " + str(e.subscriber) + " " + str(e.current_subscriber)
			if random.random() < 0.01:
				try:
					t=q.lease(tag="ReleaseLocksTask")
					t.execute()
					with open(log_file,"a") as f:
						f.write(t.chunk_position+"\n")
					q.delete(t._id)
					print("released lock")
				except TaskQueue.QueueEmpty:
					pass
def dumbsample_enqueue(q):
	import time
	q.purge()
	for i,chunk in enumerate(chunks):
		print chunk
		print i
		t = DumbsampleTask(
			chunk_position=str(chunk), 
			crop_position=chunk.crop_position(),
			input_layer=dataset_path+'errors',
			output_layer=dataset_path+'errors', 
		)
		print t
		q.insert(t)
		t = DumbsampleTask(
			chunk_position=str(chunk), 
			crop_position=chunk.crop_position(),
			input_layer=dataset_path+'residual_errors',
			output_layer=dataset_path+'residual_errors', 
		)
		print t
		q.insert(t)
	q.wait()

def stage1_task_loop():
	while True:
		try:
			t=q.lease(tag="RegionGraphTask")
			print t
			t.execute()
			q.delete(t._id)
			logger.log('INFO', t, "successfully executed")
		except TaskQueue.QueueEmpty:
			print "queue empty"
			time.sleep(1)
			continue
		except EmptyVolumeException:
			print "empty volume"
			logger.log("ERROR", t, 'empty volume')
			continue
		except Exception as e:
			logger.log("ERROR", t, 'raised {}\n {}'.format(e, traceback.format_exc()))
			raise

def stage2_task_loop():
	while True:
		try:
			t=q.lease(tag="DiscriminateTask")
			print t
			t.execute()
			q.delete(t._id)
			logger.log('INFO', t, "successfully executed")
		except TaskQueue.QueueEmpty:
			print "queue empty"
			time.sleep(1)
			continue
		except EmptyVolumeException:
			print "empty volume"
			logger.log("ERROR", t, 'empty volume')
			continue
		except Exception as e:
			logger.log("ERROR", t, 'raised {}\n {}'.format(e, traceback.format_exc()))
			raise

def stage3_task_loop(q, lease_time):
	while True:
		try:
			t=q.lease(tag="FloodFillingTask", leaseSecs=lease_time)
			print t
			t.execute()
			q.delete(t._id)
			#Let's just hope nothing crashes between these two lines!
			q.insert(ReleaseLocksTask(t.chunk_position))
			logger.log('INFO', t, "successfully executed")
		except TaskQueue.QueueEmpty:
			print "queue empty"
			time.sleep(1)
			continue
		except EmptyVolumeException as e:
			print "empty volume"
			logger.log("WARNING", t, 'empty volume')
			continue
		except Exception as e:
			logger.log("ERROR", t, 'raised {}\n {}'.format(e, traceback.format_exc()))
			raise

def dumbsample_task_loop(q, lease_time):
	while True:
		try:
			t=q.lease(tag="DumbsampleTask", leaseSecs=lease_time)
			print t
			t.execute()
			q.delete(t._id)
			logger.log('INFO', t, "successfully executed")
		except TaskQueue.QueueEmpty:
			print "queue empty"
			time.sleep(1)
			continue
		except EmptyVolumeException as e:
			print "empty volume"
			q.delete(t._id)
			logger.log("WARNING", t, 'empty volume')
			continue
		except Exception as e:
			logger.log("ERROR", t, 'raised {}\n {}'.format(e, traceback.format_exc()))
			raise
