import numpy as np

def unpack_edges(edges):
	return set(tuple(edges[i,:]) for i in xrange(edges.shape[0]))
def pack_edges(edges):
	A=np.zeros((len(edges),2), dtype=np.int64)
	for i,e in enumerate(edges):
		A[i,:]=e
	return A

def restrict(edges, full_edges):
	return edges & full_edges
