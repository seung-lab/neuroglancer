import threading
import json
from weakref import WeakValueDictionary

import tornado.ioloop
import tornado.web
from tornado import httpserver, netutil

import numpy as np
import ssl
from tasks import ServerTask as Task
from urlparse import parse_qs

class BaseHandler(tornado.web.RequestHandler):

	def initialize(self, queue, name_to_task,record):
		self.queue=queue
		self.name_to_task=name_to_task
		self.record=record

	def add_cors_headers(self):
		self.set_header("Access-Control-Allow-Origin", "*")
		self.set_header("Access-Control-Allow-Headers", "x-requested-with")
		self.set_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')

	def prepare(self):
		self.add_cors_headers()

class TaskHandler(BaseHandler):
	def get(self):
		data = json.loads(self.request.body)
		lease_time = data[u'lease_time']
		#todo: remove linear search for ready tasks
		#instead, implement a priority queue based on number of number of dependencies
		#and release time.

		#The constant time solution involving a staging queue containing 
		#only tasks without outstanding dependencies is complicated by our 
		#leasing timeouts.
		for t in self.queue:
			if t.is_ready():
				print "leasing {}".format(t.name)
				t.lease(lease_time)
				self.write(json.dumps({'name': t.name, 'payload': t.payload}))
				return
		self.set_status(204)

	def put(self):
		data = json.loads(self.request.body)
		t=Task(data[u'name'],dependencies=map(lambda x: self.name_to_task[x], data[u'dependencies']),payload=data[u'payload'])
		print "inserting {}".format(t.name)
		self.queue.append(t)
		self.name_to_task[data[u'name']]=t
		print "{} tasks in queue".format(len(self.queue))

	def delete(self):
		data = json.loads(self.request.body)
		name = data[u'name']
		task = self.name_to_task[name]
		task.delete()
		self.name_to_task[name]=None
		print "deleting {}".format(task.name)
		self.queue.remove(task)
		print "{} tasks in queue".format(len(self.queue))
		self.record.write("{}\n".format(name))
		self.record.flush()


counter=0
class SlackTaskHandler(TaskHandler):
	def post(self):
		global counter
		args = parse_qs(self.request.body)
		self.request.body = json.dumps({"name":"slack_task_{}".format(counter),"payload":args['text'][0],"dependencies":[]})
		self.put()
		counter+=1

def make_app(path):
	args =  {
		'queue': [],
		'name_to_task': {},
		'record': open("log.txt",'w')
	}

	app = tornado.web.Application([
		(r'/1.0/?', TaskHandler, args),
		(r'/slack/?', SlackTaskHandler, args),
	], debug=True)

	app.args = args
	return app

def start_server(path=None):
	app = make_app(path)
	http_server = tornado.httpserver.HTTPServer(app)
	http_server.bind(8080)
	http_server.start(1)
	tornado.ioloop.IOLoop.current().start()

	# thread = threading.Thread(target=tornado.ioloop.IOLoop.instance().start)
	# thread.daemon = True
	# thread.start()

	# 0: ('::', 53044, 0, 0)
	# 1: ('0.0.0.0', 53286)

	return 'http://localhost:%s' % sockets[1].getsockname()[1]

if __name__ == '__main__':
   start_server()

