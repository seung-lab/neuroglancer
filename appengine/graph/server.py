import webapp2
import os
import json
from octree import Octree
from neuroglancer.pipeline import Storage

graphs = {}

def normalize_path(path):
    path = Storage.extract_path(path)
    if path is None:
        return None

    clean = filter(None,[path.bucket_name,
                         path.dataset_path,
                         path.dataset_name,
                         path.layer_name])
    return  os.path.join(*clean)

class GraphHandler(webapp2.RequestHandler):
    def post(self):
        try:
            body = json.loads(self.request.body)
            path = normalize_path(str(body['path']))
            dim = tuple(int(i) for i in body['size'])
            if path is None:
                raise ValueError("Invalid path")
            if len(dim) != 3 or min(dim) < 1:
                raise ValueError("Invalid dimensions")

        except Exception as e:
          self.response.status = 400
          self.response.write(e)
          return
        
        if path in graphs:
            self.response.status = 409
            self.response.write("Overriding existing graphs is not allowed.")
            return

        graphs[path] = Octree(size=dim, path=path)

class NodeHandler(webapp2.RequestHandler):
    def put(self, graph_name, label):
        try:
            label = int(label)
            graphs[graph_name].add_atomic_node(label)
        except ValueError as e:
            self.response.status = 400
            self.response.write(e)

class RootHandler(webapp2.RequestHandler):
    def get(self, graph_name, label):
        try:
            label = int(label)
            root_label = graphs[graph_name].get_root_label(label)
            self.response.write(json.dumps(root_label))
        except ValueError as e:
            self.response.status = 404
            self.response.write(e)

class ChildrenHandler(webapp2.RequestHandler):
    def get(self, graph_name, label):
        try:
            label = int(label)
            node = graphs[graph_name].get_node(label)
            self.response.write(json.dumps(node.children))
        except ValueError as e:
            self.response.status = 404
            self.response.write(e)

class LeavesHandler(webapp2.RequestHandler):
    def get(self, graph_name, label):
        try:
            label = int(label)
            leaf_labels = graphs[graph_name].get_leaf_labels(label)
            self.response.write(json.dumps(leaf_labels))
        except ValueError as e:
            self.response.status = 404
            self.response.write(json.dumps(e))

class EdgeHandler(webapp2.RequestHandler):
    def put(self, graph_name, label_u, label_v):
        try:
            label_u = int(label_u)
            label_v = int(label_v)
            graphs[graph_name].add_atomic_edge(label_u, label_v)
            root_label = graphs[graph_name].get_root_label(label_u)
            self.response.write(json.dumps(root_label))
        except ValueError as e:
            self.response.status = 404
            self.response.write(e)
    
    def delete(self, graph_name, label_u, label_v):
        try:
            label_u = int(label_u)
            label_v = int(label_v)
            graphs[graph_name].delete_atomic_edge(label_u, label_v)
            root_labels = [graphs[graph_name].get_root_label(label_u),
                           graphs[graph_name.get_root_label(label_v)]]
            self.response.write(json.dumps(root_labels))
        except ValueError as e:
            self.response.status = 404
            self.response.write(e)

class MergeHandler(webapp2.RequestHandler):
    pass # TODO: Only atomic edges for now

class SplitHandler(webapp2.RequestHandler):
    pass # TODO: Only atomic edges for now

class SubgraphHandler(webapp2.RequestHandler):
    pass # TODO: Modify YACN

app = webapp2.WSGIApplication([
    (r'/1.0/graph/?', GraphHandler),

    (r'/1.0/graph/(.*)/node/(\d+)/?', NodeHandler),
    (r'/1.0/graph/(.*)/node/(\d+)/root/?', RootHandler),
    (r'/1.0/graph/(.*)/node/(\d+)/children/?', ChildrenHandler),
    (r'/1.0/graph/(.*)/node/(\d+)/leaves/?', LeavesHandler),
    (r'/1.0/graph/(.*)/edge/(\d+),(\d+)/?', EdgeHandler),
    (r'/1.0/graph/(.*)/edge/(\d+),(\d+)/merge?', MergeHandler),
    (r'/1.0/graph/(.*)/edge/(\d+),(\d+)/split?', SplitHandler),

    (r'/1.0/graph/(.*)/subgraph/?', SubgraphHandler),

], debug=True)

def main():
    import struct
    import labels
    import sys

    SERVER = 'http://128.112.220.121:4000/1.0/graph'
    DATASET = 'neuroglancer/pinky40_v11/watershed_cutout'

    graphs[DATASET] = Octree(size=(256,256,256), path=DATASET)

    with open("/usr/people/nkemnitz/testing/vertices.bin") as fv:
        while True:
            tmp = fv.read(8)
            if len(tmp) == 0:
                break

            s, z, y, x, l = struct.unpack('IBBBB', tmp)
            u = labels.to_label(l-1, x, y, z, s)
            print('{}/{}/node/{}'.format(SERVER, DATASET, u))
            sys.stdout.flush()

            graphs[DATASET].add_atomic_node(u)

    with open("/usr/people/nkemnitz/testing/edges.bin") as fe:
        while True:
            tmp = fe.read(16)
            if len(tmp) == 0:
                break
            s1, z1, y1, x1, l1, s2, z2, y2, x2, l2 = struct.unpack('IBBBBIBBBB', tmp)
            u = labels.to_label(l1-1, x1, y1, z1, s1)
            v = labels.to_label(l2-1, x2, y2, z2, s2)
            print('{}/{}/edge/{},{}'.format(SERVER, DATASET, u, v))
            sys.stdout.flush()

            graphs[DATASET].add_atomic_edge(u,v)


    from paste import httpserver
    httpserver.serve(app, host='0.0.0.0', port='4000')

if __name__ == '__main__':
    main()
