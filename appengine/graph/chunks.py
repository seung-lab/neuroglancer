import networkx as nx
import cPickle

class NodeData(object):

    def __init__(self, parent=None,
                 children=None, ext_edges=None):

        self._parent = parent
        self._children = children or []
        self._ext_edges = ext_edges or []

    @property
    def parent(self):
        return self._parent

    @parent.setter
    def parent(self, value):
        self._parent = value

    @property
    def children(self):
        return self._children

    @property
    def ext_edges(self):
        return self._ext_edges

    def add_external_edge(self, e):
        """
        We will accept external edges
        that already exists

        because when we delete an edge
        we will try to add all external edges
        TODO explain this better
        """
        if e in self._ext_edges:
            return
        self._ext_edges.append(e)

    def delete_external_edge(self, e):
        """
        If eternal edge doesn't exist
        raises value error
        """
        if e not in self._ext_edges:
            raise ValueError("Edge doesn't exists")
        self._ext_edges.remove(e)

    def __repr__(self):
        return "NodeData(parent={},"\
                "children={},"\
                "ext_edges={})".format(
            self._parent, self._children, self._ext_edges)  

class Chunk(object):

    def __init__(self):
        self._g = nx.Graph()
        self._is_dirty = False

    def from_string(self, s):
        """
        Unserialize object
        """
        if s is None:
            self._g = nx.Graph()
        else:
            self._g = cPickle.loads(s)
        return self

    def to_string(self):

        # We assume that every time this is called
        # is to save it to a persistent storage
        self._is_dirty = False
        return cPickle.dumps(self._g)

    @property
    def is_dirty(self):
        return self._is_dirty
    
    def add_node(self, intra, **kwargs):
        self._is_dirty = True
        self._g.add_node(intra, d=NodeData(**kwargs))

    def get_node(self, intra):
        """
        raise KeyError if node doesn't exists
        """
        # this might modify our node data
        # so we need to mark as dirty
        # TODO check if actual data is modified
        self._is_dirty = True
        return self._g.node[intra]['d']

    def has_node(self, intra):
        return self._g.has_node(intra)

    def delete_node(self, intra):
        self._is_dirty = True
        self._g.remove_node(intra)

    def add_edge(self, intra_u, intra_v, atomic_edge):
        self._is_dirty = True
        try:
            data = self.get_edge(intra_u, intra_v)
            if atomic_edge in data:
                raise ValueError("Edge already exists")
            data.append(atomic_edge)
        except KeyError:
            self._g.add_edge(intra_u, intra_v, d=[atomic_edge])

    def get_edge(self, intra_u, intra_v):
        return self._g[intra_u][intra_v]['d']

    def has_edge(self, intra_u, intra_v):
        try:
            self.get_edge(intra_u, intra_v) 
            return True
        except KeyError:
            return False

    def delete_edge(self, intra_u, intra_v, edge):
        self._is_dirty = True
        edges = self.get_edge(intra_u, intra_v)
        edges.remove(edge)
        if not edges:
            self._g.remove_edge(intra_u, intra_v)

    def get_connected_component(self, intra):
        return nx.node_connected_component(self._g, intra)

    def get_atomic_edges(self, intra):
        for edge in  self._g.edges(intra, data='d'):
            # TODO on travis edge[2] is directly the list
            # but on my laptop edge[2] is a dictionary
            # so I need to to atomic_edges = edge[2]['d'] instead
            atomic_edges = edge[2]
            for ae in atomic_edges:
                yield ae.head, ae.tail