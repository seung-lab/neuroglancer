import time

class ServerTask():
	def __init__(self, name, dependencies, payload):
		self.name=name
		self.parents = filter(lambda x: x is not None, dependencies)
		self.children = set([])
		for parent in self.parents:
			parent.children.add(self)
		self.release_time = time.time()
		self.payload=payload
	
	def __hash__(self):
		return hash(self.name)

	def __eq__(self, other):
		return self.name == other.name

	def is_ready(self):
		return len(self.parents)==0 and time.time() > self.release_time
	
	def lease(self, lease_time=600):
		self.release_time = time.time() + lease_time

	def delete(self):
		for child in self.children:
			child.parents.remove(self)

class ClientTask():
	def __init__(self, name, payload):
		self.name = name
		self.payload = payload
