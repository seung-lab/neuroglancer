import tornado.ioloop
import tornado.web

import networkx as nx
import json
import numpy as np
from weakref import WeakValueDictionary


class BaseHandler(tornado.web.RequestHandler):

    def initialize(self, G, sets, node2sets, threshold):
        self.G = G
        self.sets = sets
        self.node2sets = node2sets
        self.threshold = threshold

    def add_cors_headers(self):
        self.set_header("Access-Control-Allow-Origin", "*")
        self.set_header("Access-Control-Allow-Headers", "x-requested-with")
        self.set_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')

    def prepare(self):
        self.add_cors_headers()

class NodeHandler(BaseHandler):
    def get(self, u):
        #TODO(tartavull) add optional threshold argument
        u = int(u)
        if self.G.has_node(u):
            stack  = [u]
            visited = set()
            while len(stack):
                node = stack.pop()
                if node in visited:
                    continue

                # Here is some tricky code
                # if the node we chose is part of an object we include
                # all the nodes in that object
                # if we chose an element which is connected with higher
                # than threshold capacity to an object, we also include all
                # nodes in that object.
                # But we don't add the nodes of the objects to the stack, because
                # we don't want to search for the neighbors of this object, because we
                # asume that they are already correct.
                if node in self.node2sets:
                    visited = visited.union(self.node2sets[node])

                for e0, e1, data in self.G.edges_iter(nbunch=node,data=True):
                    visited.add(node)

                    capacity = data['capacity']
                    assert e0 == node
                    if capacity > self.threshold and e1 not in visited:
                        stack.append(e1)

            #TODO(tartavull) make this 64 bits once neuroglancer can handle it
            data = np.array(list(visited)).astype(np.uint32).tostring()
            self.write(data)

        else:
            self.clear()
            self.set_status(400)
            self.finish()

    def post(self, u):
        u = int(u)

        self.G.add_node(u)
        self.clear()
        self.set_status(200)
        self.finish()

    def delete(self, u):
        u = int(u)
        
        if self.G.has_node(u):
            self.G.remove_node(u)
            self.clear()
            self.set_status(200)
            self.finish()
        else:
            self.clear()
            self.set_status(400)
            self.finish()

class EdgeHandler(BaseHandler):
    def get(self, u, v):
        """        
        Args:
            u (int): node
            v (int): node
        
        Returns:
            JSON: properties of the edge
        """
        u = int(u); v = int(v)

        if self.G.has_edge(u,v):
            self.finish(json.dumps(self.G[u][v]))
        else:
            self.clear()
            self.set_status(400)
            self.finish()

    def post(self, u, v):
        u = int(u); v = int(v)
        self.G.add_edge(u,v, capacity=1.0) #TODO(tartavull) add capacity for min cut

    def delete(self, u, v):
        u = int(u); v = int(v)
        self.G.remove_edge(u,v)

class SplitHandler(BaseHandler):
    def post(self, u, v): #TODO(tartavull) write a test for this to make sure it is working
        u = int(u); v = int(v)

        print u, v
        if u not in self.node2sets or v not in self.node2sets:
            self.set_status(400)
            return

        u_set = self.node2sets[u]
        v_set = self.node2sets[v]
        if u_set != v_set:
            self.set_status(400)
            return

        H = self.G.subgraph(list(u_set))
        cut_value, partitions = nx.minimum_cut(H, u, v)
        partitions = map(lambda x: map(int,x), partitions)
        self.finish(json.dumps(partitions))


class ObjectHandler(BaseHandler):
    """It treats a set of supervoxels as an object.
       It will merge objects into a new one if a new object is post that
       contains at least one member of an already existent object.

       This is completly independent of the global region graph. When an object
       is created this doesn't check if the provided nodes ids actually exist in
       the global graph.
    """

    def get(self):
        self.write(json.dumps(map(list,self.sets)))

    def post(self):
        nodes = tornado.escape.json_decode(self.request.body)
        nodes = map(int, nodes)
        new_set = set(nodes)
        for node in nodes:
            if node in self.node2sets:
                new_set = new_set.union(self.node2sets[node])
                self.sets.remove(self.node2sets[node])
        for node in nodes:
            self.node2sets[node] = new_set
        self.sets.append(new_set)
        
        self.set_status(200)
        self.finish()



def make_app(test=False):
    if not test:
        G = nx.read_gpickle('snemi3d_graph.pickle')
        print 'graph restored'
    else:
        G = nx.Graph()

    def threshold_graph(G):
        for edge in G.edges_iter(data=True):
            u, v, data = edge
            if float(data['capacity']) < 0.8: #threshold for removing edges
                G.remove_edge(u,v)

    threshold_graph(G)

    args =  {'G':G,
             'sets': [],
             'node2sets': WeakValueDictionary(),
             'threshold': 0.8}

    app = tornado.web.Application([
        (r'/1.0/node/(\d+)/?', NodeHandler, args),
        (r'/1.0/edge/(\d+)/(\d+)/?', EdgeHandler, args),
        (r'/1.0/split/(\d+)/(\d+)/?', SplitHandler, args),
        (r'/1.0/object/?', ObjectHandler, args),
    ], debug=True)

    app.args = args
    return app


if __name__ == '__main__':
    app = make_app()
    app.listen(8888)
    tornado.ioloop.IOLoop.current().start()