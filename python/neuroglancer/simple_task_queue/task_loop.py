from neuroglancer.pipeline import *
import task_queue
import time

tq=task_queue.TaskQueue("http://50.16.149.198:8001/1.0")
while True:
	try:
		task = tq.lease(60)
		print task.payload
		print eval(task.payload)
		tq.delete(task.name)
	except Exception as e:
		print e
		time.sleep(1)
