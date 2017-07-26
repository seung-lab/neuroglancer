#!/use/bin/python

"""
This script can be used to generate standard obj files
from precomputed neuroglancer meshes. This can be useful
to e.g. provide meshes to 3D graphics artists.

Mesh Format Documentation:
https://github.com/google/neuroglancer/tree/master/src/neuroglancer/datasource/precomputed#mesh-representation-of-segmented-object-surfaces

The code is heavily based on the work done by Ricardo Kirkner. 

Example Command:
    python ngmesh2obj.py SEGID1 SEGID2 SEGID3 

Example Output:
    obj files for SEGID1 in ./SEGID1/
    obj files for SEGID2 in ./SEGID2/
    obj files for SEGID3 in ./SEGID3/
"""

from cStringIO import StringIO
import gzip
import json
import os
import struct
import sys

from neuroglancer.lib import mkdir
from neuroglancer.pipeline import CloudVolume, Storage

def download_fragments(cloudpath, mesh_id):
  vol = CloudVolume(cloudpath)
  mesh_dir = vol.info['mesh']

  download_path = os.path.join(mesh_dir, mesh_id + ':0')

  with Storage(cloudpath) as stor:
    fragments = json.loads(stor.get_file(download_path))['fragments']
    paths = [ os.path.join(mesh_dir, fragment) for fragment in fragments ]
    frag_datas = stor.get_files(paths)  
  return frag_datas

def decode_downloaded_data(frag_datas):
  data = {}
  for result in frag_datas:
    data[result['filename']] = decode_mesh_buffer(result['content'])
  return data

def decode_mesh_buffer(fragment):
    num_vertices = struct.unpack("=I", fragment[0:4])[0]
    vertex_data = fragment[4:4+(num_vertices*3)*4]
    face_data = fragment[4+(num_vertices*3)*4:]
    vertices = []

    if len(vertex_data) % 12 != 0:
      print("Unable to process fragment.")
      return { 'num_vertices': 0, 'vertices': [], 'faces': [] }

    for i in xrange(0, len(vertex_data), 12):
      x = struct.unpack("=f", vertex_data[i:i+4])[0]
      y = struct.unpack("=f", vertex_data[i+4:i+8])[0]
      z = struct.unpack("=f", vertex_data[i+8:i+12])[0]
      vertices.append((x,y,z))

    faces = []
    for i in xrange(0, len(face_data), 4):
      p = struct.unpack("=I", face_data[i:i+4])[0]
      faces.append(p)

    return {
      'num_vertices': num_vertices, 
      'vertices': vertices, 
      'faces': faces
    }

def mesh_to_obj(fragment, num_prev_verticies):
    objdata = []
    
    for vertex in fragment['vertices']:
        objdata.append('v %s %s %s' % (vertex[0], vertex[1], vertex[2]))
    
    faces = [ face + num_prev_verticies + 1 for face in fragment['faces'] ]
    for i in xrange(0, len(faces), 3):
      objdata.append('f %s %s %s' % (faces[i], faces[i+1], faces[i+2]))
    
    return objdata

def save_mesh(mesh_id, meshdata):
  num_vertices = 0
  with open('./{}.obj'.format(mesh_id), 'wb') as f:
    for name, fragment in meshdata.items():
      mesh_data = mesh_to_obj(fragment, num_vertices)
      f.write('\n'.join(mesh_data) + '\n')
      num_vertices += fragment['num_vertices']


if __name__ == '__main__':
  prog, cloudpath = sys.argv[:2]
  mesh_ids = sys.argv[2:]

  for mesh_id in mesh_ids:
    print "downloading " + mesh_id + '...'
    meshdata = download_fragments(cloudpath, mesh_id)
    print "decoding..."
    meshdata = decode_downloaded_data(meshdata)
    print "saving to obj..."
    save_mesh(mesh_id, meshdata)
    print "done."
    


