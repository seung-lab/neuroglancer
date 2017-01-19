import tornado.ioloop
import tornado.web
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

class NodeHandler(tornado.web.RequestHandler):
    def get(self, u):
        u = int(u)
        if G.has_node(u):
            self.set_header("Access-Control-Allow-Origin", "*")
            self.set_header("Access-Control-Allow-Headers", "x-requested-with")
            self.set_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
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
            self.set_header("Access-Control-Allow-Origin", "*")
            self.set_header("Access-Control-Allow-Headers", "x-requested-with")
            self.set_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
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
        self.clear()
        self.set_header("Access-Control-Allow-Origin", "*")
        self.set_header("Access-Control-Allow-Headers", "x-requested-with")
        self.set_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
        self.set_status(400)
        self.finish(json.dumps(partitions))


class ObjectHandler(tornado.web.RequestHandler):
    def get(self):
        self.set_header("Access-Control-Allow-Origin", "*")
        self.set_header("Access-Control-Allow-Headers", "x-requested-with")
        self.set_header('Access-Control-Allow-Methods', 'POST, GET')
        self.write(json.dumps(map(list,sets)))

    def post(self):
        self.clear()
        self.set_header("Access-Control-Allow-Origin", "*")
        self.set_header("Access-Control-Allow-Headers", "x-requested-with")
        self.set_header('Access-Control-Allow-Methods', 'POST, GET')

        nodes = tornado.escape.json_decode(self.request.body)['nodes']
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

if __name__ == "__main__":
    app = make_app()
    app.listen(8888)
    tornado.ioloop.IOLoop.current().start()

