import tornado.ioloop
import tornado.web
import networkx as nx
import json

try:
    G = nx.read_gpickle('snemi3d_graph.pickle')
except:
    G = nx.Graph()

def threshold_graph(G):
    count = 0
    for edge in G.edges_iter(data=True):
        u, v, data = edge
        if float(data['capacity']) < 0.4: #threshold for removing edges
            count += 1
    print count / float(len(G.edges()))

threshold_graph(G)

class NodeHandler(tornado.web.RequestHandler):
    def get(self, u):
        if G.has_node(u):
            self.finish(json.dumps(G.neighbors(u)))
        else:
            self.clear()
            self.set_status(400)
            self.finish()

    def post(self, u):
        G.add_node(u)
        self.clear()
        self.set_status(200)
        self.finish()

    def delete(self, u):
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
        if G.has_edge(u,v):
            self.finish(json.dumps(G[u][v]))
        else:
            self.clear()
            self.set_status(400)
            self.finish()

    def post(self, u, v):
        G.add_edge(u,v, capacity=1.0) #TODO add capacity for min cut

    def delete(self, u, v):
        G.remove_edge(u,v)

class SplitHandler(tornado.web.RequestHandler):
    def post(self, u, v):
        cut_value, partitions = nx.minimum_cut(G, u, v)
        partitions = map(list, partitions)
        self.clear()
        self.set_status(400)
        self.finish(json.dumps(partitions))

def make_app():
    return tornado.web.Application([
        (r'/node/(\d+)', NodeHandler),
        (r'/edge/(\d+)/(\d+)', EdgeHandler),
        (r'/split/(\d+)/(\d+)', SplitHandler),
    ])

if __name__ == "__main__":
    app = make_app()
    app.listen(8888)
    tornado.ioloop.IOLoop.current().start()

