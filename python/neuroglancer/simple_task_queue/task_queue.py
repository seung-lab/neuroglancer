import requests
import json
from time import sleep
from tasks import ClientTask as Task
class QueueEmptyException(Exception):
	pass
class TaskQueue():
	def __init__(self, url):
		self.url=url
		self.counter=0
	def insert(self,name,payload,dependencies=[]):
		dependencies = list(dependencies)
		return requests.put(self.url, data=json.dumps({'name': name,'payload': payload, 'dependencies':dependencies}))
	def lease(self,lease_time):
		r = requests.get(self.url, data=json.dumps({'lease_time': lease_time}))
		if r.status_code == 204:
			raise QueueEmptyException()
		assert r.status_code == 200
		data = json.loads(r.text)
		return Task(data['name'], data['payload'])
	def delete(self,name):
		return requests.delete(self.url, data=json.dumps({'name': name}))
