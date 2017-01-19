import tornado.ioloop
import tornado.web
from tornado.testing import AsyncHTTPTestCase

import networkx as nx
import json
import numpy as np
from weakref import WeakValueDictionary

try:
    G = nx.read_gpickle('snemi3d_graph.pickle')
    print 'graph restored'
except:
    G = nx.Graph()

# Global objects because I don't know how to have class members
sets = []
node2sets = WeakValueDictionary()


def threshold_graph(G):
    for edge in G.edges_iter(data=True):
        u, v, data = edge
        if float(data['capacity']) < 0.8: #threshold for removing edges
            G.remove_edge(u,v)

threshold_graph(G)

def add_cors_headers(self):
    self.set_header("Access-Control-Allow-Origin", "*")
    self.set_header("Access-Control-Allow-Headers", "x-requested-with")
    self.set_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')

class NodeHandler(tornado.web.RequestHandler):
    def get(self, u):
        u = int(u)
        if G.has_node(u):
            add_cors_headers(self)
            data = np.array(G.neighbors(u)).tostring()
            self.write(data)

        else:
            self.clear()
            self.set_status(400)
            self.finish()

    def post(self, u):
        u = int(u)

        G.add_node(u)
        self.clear()
        self.set_status(200)
        self.finish()

    def delete(self, u):
        u = int(u)
        
        if G.has_node(u):
            G.remove_node(u)
            self.clear()
            self.set_status(200)
            self.finish()
        else:
            self.clear()
            self.set_status(400)
            self.finish()

class EdgeHandler(tornado.web.RequestHandler):
    def get(self, u, v):
        """        
        Args:
            u (int): node
            v (int): node
        
        Returns:
            JSON: properties of the edge
        """
        u = int(u); v = int(v)

        if G.has_edge(u,v):
            add_cors_headers(self)
            self.finish(json.dumps(G[u][v]))
        else:
            self.clear()
            self.set_status(400)
            self.finish()

    def post(self, u, v):
        u = int(u); v = int(v)
        G.add_edge(u,v, capacity=1.0) #TODO add capacity for min cut

    def delete(self, u, v):
        u = int(u); v = int(v)
        G.remove_edge(u,v)

class SplitHandler(tornado.web.RequestHandler):
    def post(self, u, v):
        u = int(u); v = int(v)
        cut_value, partitions = nx.minimum_cut(G, u, v)
        partitions = map(list, partitions)
        add_cors_headers(self)
        self.set_status(400)
        self.finish(json.dumps(partitions))


class ObjectHandler(tornado.web.RequestHandler):
    """It treats a set of supervoxels as an object.
       It will merge objects into a new one if a new object is post that
       contains at least one member of an already existent object.

       This is completly independent of the global region graph. When an object
       is created this doesn't check if the provided nodes ids actually exist in
       the global graph.
    """
    def get(self):
        add_cors_headers(self)
        self.write(json.dumps(map(list,sets)))

    def post(self):
        add_cors_headers(self)
        nodes = tornado.escape.json_decode(self.request.body)
        new_set = set(nodes)
        for node in nodes:
            if node in node2sets:
                new_set = new_set.union(node2sets[node])
                sets.remove(node2sets[node])
        for node in nodes:
            node2sets[node] = new_set
        sets.append(new_set)
        
        self.set_status(200)
        self.finish()



def make_app():
    return tornado.web.Application([
        (r'/1.0/node/(\d+)', NodeHandler),
        (r'/1.0/edge/(\d+)/(\d+)', EdgeHandler),
        (r'/1.0/split/(\d+)/(\d+)', SplitHandler),
        (r'/1.0/object/', ObjectHandler),
    ])



class TestObjectHandler(AsyncHTTPTestCase):
    def get_app(self):
        return make_app()

    def check_get(self, arr):
        self.http_client.fetch(
            self.get_url('/1.0/object/'),
            self.stop,
            method="GET"
        )
        response = self.wait()
        self.assertEquals(json.loads(response.body), arr)

    def check_post(self, arr):
        self.http_client.fetch(
            self.get_url('/1.0/object/'),
            self.stop,
            body=json.dumps(arr), #TODO(wms) can we just return an array?
            method="POST"
        )

    def test_empty(self):
        self.check_get([])

    def test_insertion(self):
        self.check_post([1,2,3])
        self.check_get([[1,2,3]])

        # adds the same stuff once again
        self.check_post([1,2,3])
        self.check_get([[1,2,3]])

        # adds an independent objects
        self.check_post([4,5,6])
        self.check_get([[1,2,3],[4,5,6]])

        # adds another set that merges the two objects from before
        self.check_post([5,6,1,7])
        self.check_get([[1,2,3,4,5,6,7]])


if __name__ == '__main__':
    app = make_app()
    app.listen(8888)
    tornado.ioloop.IOLoop.current().start()