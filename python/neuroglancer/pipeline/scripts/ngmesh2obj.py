#!/use/bin/python

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

    while vertex_data:
        try:
            x = struct.unpack("=f", vertex_data[0:4])[0]
            y = struct.unpack("=f", vertex_data[4:8])[0]
            z = struct.unpack("=f", vertex_data[8:12])[0]
        except Exception as exc:
            import pdb; pdb.set_trace()
            pass
        vertices.append((x,y,z))
        vertex_data = vertex_data[12:]

    faces = []
    while face_data:
        p = struct.unpack("=I", face_data[0:4])[0]
        faces.append(p)
        face_data = face_data[4:]

    return {
      'num_vertices': num_vertices, 
      'vertices': vertices, 
      'faces': faces
    }

def mesh_to_obj(fragment):
    objdata = []
    
    for vertex in fragment['vertices']:
        objdata.append('v %s %s %s' % (vertex[0], vertex[1], vertex[2]))
    
    faces = fragment['faces']
    for i in xrange(0, len(faces), 3):
      objdata.append('f %s %s %s' % (faces[i]+1, faces[i+1]+1, faces[i+2]+1))
    
    return objdata

def save_mesh(mesh_id, meshdata):
  mkdir(mesh_id)
  for name, fragment in meshdata.items():
      mesh_data = mesh_to_obj(fragment)
      name = os.path.basename(name)
      with open('./{}/{}.obj'.format(mesh_id, name), 'wb') as f:
        f.write('\n'.join(mesh_data))

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
    


