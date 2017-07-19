import webapp2
from labels import from_label
from collections import defaultdict

  



graphs = defaultdict(Octree)


class NodeHandler(webapp2.RequestHandler):

    pass

class MergeHandler(webapp2.RequestHandler):
    pass

class SplitHandler(webapp2.RequestHandler):
    pass

class SubgraphHandler(webapp2.RequestHandler):
    pass

class ChildrenHandler(webapp2.RequestHandler):
    def get(self, graph_name, label):
        # get a list of all children for a given vertex
        label = int(label)
        node = graphs[graph_name].get_node(label)
        if not node:
            self.response.status = 404

        #maybe return binary data
        #or better have a query string that
        #indicates how to encode response
        self.response.write(json.dumps(node.children))



class GraphHandler(webapp2.RequestHandler):
    pass


app = webapp2.WSGIApplication([
    (r'/v1/graph/(.*)/node/(\d+)/?', NodeHandler),
    (r'/v1/graph/(.*)/merge/(\d+),(\d+)/?', MergeHandler),
    (r'/v1/graph/(.*)/split/(\d+),(\d+)/?', SplitHandler),
    (r'/v1/graph/(.*)/subgraph/?', SubgraphHandler),
    (r'/v1/graph/(.*)/children/(\d+)/?', ChildrenHandler),
    (r'/v1/graph/(.*)?', GraphHandler),

], debug=True)
