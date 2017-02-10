# distutils: language = c++
# distutils: sources = cMesher.cpp

# Cython interface file for wrapping the object
#
#

from libcpp.vector cimport vector
from libcpp cimport bool
from libcpp.string cimport string

# c++ interface to cython
cdef extern from "cMesher.h":
    cdef struct meshobj:
        vector[unsigned int] points
        vector[float] normals
        vector[unsigned int] faces

    cdef cppclass cMesher:
        cMesher() except +
        void mesh(vector[unsigned int], unsigned int, unsigned int, unsigned int)
        vector[unsigned int] ids()
        meshobj get_mesh(unsigned int, bool normals)
        bool write_obj(unsigned int id, string filename)

# creating a cython wrapper class
cdef class Mesher:
    cdef cMesher *thisptr      # hold a C++ instance which we're wrapping
    def __cinit__(self):
        self.thisptr = new cMesher()
    def __dealloc__(self):
        del self.thisptr
    def mesh(self, data, sx, sy, sz):
        self.thisptr.mesh(data, sx, sy, sz)
    def ids(self):
        return self.thisptr.ids()
    def get_mesh(self, mesh_id, normals=False):
        return self.thisptr.get_mesh(mesh_id, normals)
    def write_obj(self, mesh_id, filename):
        return self.thisptr.write_obj(mesh_id, filename)
