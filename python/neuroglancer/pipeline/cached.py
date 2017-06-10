#currently only works for single argument, hashable arguments
class Cached():
	def __init__(self,f):
		self.f=f
		self.d={}
	def __call__(self, arg):
		if not arg in self.d:
			self.d[arg]=self.f(arg)
		return self.d[arg]
