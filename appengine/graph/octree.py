from __future__ import division
from __future__ import absolute_import

import numpy as np
from chunks import Chunk
import chunk_io
import labels

class UnorderedPair(object):
    def __init__(self, first, second):

        if first < second:
            self._head = first
            self._tail = second
        else:
            self._head = first
            self._tail = second

    @property
    def head(self):
        return self._head

    @property
    def tail(self):
        return self._tail

    def __eq__(self, other):
        return (self.head == other.head and
                self.tail == other.tail)

    def __hash__(self):
        return hash(self.head + self.tail)

    def __repr__(self):
        return "UnorderedPair({},{})".format(self.head, self.tail)

class Octree(object):

    def __init__(self, size=(1,1,1), path=''):
        """
        size indicates how many chunks are at height 0
        path is used to know where to serialize it's chunks
        """
        assert min(size) > 0
        self._size = size
        self._path = path

    @property
    def max_height(self):
        return int(max(np.log2(list(self._size))))

    def _max_x(self, height=0):
        assert height >= 0
        if height > self.max_height:
            return 0
        return self._size[0] - 1 // 2**height
    
    def _max_y(self, height=0):
        assert height >= 0
        if height > self.max_height:
            return 0
        return self._size[1] - 1 // 2**height

    def _max_z(self, height=0):
        assert height >= 0
        if height > self.max_height:
            return 0
        return self._size[2] - 1 // 2**height
        

    def get_chunk_parent(self, chunk_key):
        height, x, y, z = labels.from_chunk_key(chunk_key)
        if (not self._is_chunk_valid(height, x, y, z) or
            height+1 > self.max_height):
            return None
        return labels.to_chunk_key(height+1, x//2, y//2, z//2)

    def get_chunk_children(self, chunk_key):
        height, x, y, z = labels.from_chunk_key(chunk_key)
        if (not self._is_chunk_valid(height, x, y, z)
            or height < 1):
            raise StopIteration()

        max_x = min(x+1, self._max_x(height-1))
        max_y = min(y+1, self._max_y(height-1))
        max_z = min(z+1, self._max_z(height-1))
        for c_x in xrange(x, max_x+1):
            for c_y in xrange(y, max_y+1):
                for c_z in xrange(z, max_z+1):
                    yield labels.to_chunk_key(height-1, c_x, c_y, c_z)

    def _is_chunk_valid(self, height, x, y ,z):
        if (0 > x or x > self._max_x(height) or
            0 > y or y > self._max_y(height) or
            0 > z or z > self._max_z(height) or
            height > self.max_height or height < 0):
            return False
        return True

    def get_chunk(self, chunk_key):
        """
        We want to have a single cache to be able to 
        keep easier control of memory usage

        The chunk_io module will own this cache
        """
        return chunk_io.get_chunk(self._path, chunk_key)

    def get_node(self, label):
        height, x, y, z , intra = labels.from_label(label)
        if not self._is_chunk_valid(height, x, y, z):
            raise ValueError("Not a valid chunk")

        chunk = self.get_chunk(
            labels.to_chunk_key(height, x, y, z))
        return chunk.get_node(intra)

    def _add_edge(self, label_u, label_v, edge):
        height_u, x_u, y_u, z_u, intra_u = labels.from_label(label_u)
        height_v, x_v, y_v, z_v, intra_v = labels.from_label(label_v)

        #we check in add_atomic_edge that its true
        assert  height_u == height_v
        parent_u = self.get_node(label_u).parent
        parent_v = self.get_node(label_v).parent

        if (x_u != x_v or
            y_u != y_v or
            z_u != z_v):
            # edges can only be added between
            # nodes beloging to the same chunk
            self._add_edge(parent_u, parent_v, edge)
            return

        chunk = self.get_chunk(
            labels.to_chunk_key(height_u, x_u, y_u, z_u))
        chunk.add_edge(intra_u, intra_v, edge)

        new_parent = self._merge_node_recursive(parent_u, parent_v)
        chunk.get_node(intra_u).parent = new_parent
        chunk.get_node(intra_v).parent = new_parent

    def _merge_node_recursive(self, label_u, label_v):
        if not label_u:
            return

        height_u, x_u, y_u, z_u, intra_u = labels.from_label(label_u)
        height_v, x_v, y_v, z_v, intra_v = labels.from_label(label_v)
        assert (height_u, x_u, y_u, z_u) == (height_v, x_v, y_v, z_v)

        chunk_key = labels.to_chunk_key(height_u, x_u, y_u, z_u)
        chunk = self.get_chunk(chunk_key)

        ch_u = chunk.get_node(intra_u).children
        ch_v = chunk.get_node(intra_v).children
        children = ch_u + ch_v
        new_intra = labels.intra_hash_from_children(children)
        while chunk.has_node(new_intra):
            new_intra =  (new_intra + 1) % 2**24

        new_parent = self._merge_node_recursive(
            chunk.get_node(intra_u).parent,
            chunk.get_node(intra_v).parent)
        
        chunk.add_node(new_intra, children=children, parent=new_parent)
        chunk.delete_node(intra_u)
        chunk.delete_node(intra_v)

        return labels.from_chunk_key_and_intra(chunk_key, new_intra)

    def add_atomic_edge(self, label_u, label_v):
        if label_u == label_v:
            raise ValueError("We don't allow for self edges")

        height_u, x_u, y_u, z_u, intra_u = labels.from_label(label_u)
        height_v, x_v, y_v, z_v, intra_v = labels.from_label(label_v)

        if height_u != 0 or height_v != 0:
            raise ValueError("Edge can only be added between "\
                              "atomic nodes")

        #This will check that the chunks are valid
        node_u = self.get_node(label_u)
        node_v = self.get_node(label_v)
        edge = UnorderedPair(label_u, label_v)
        if (x_u, y_u, z_u) !=  (x_v, y_v, z_v): 
            node_u.add_external_edge( edge )
            node_v.add_external_edge( edge )

        self._add_edge( label_u, label_v, edge)

    def _add_node_recursive(self, chunk_key, intra=None,
        children=[], parent=None):

        if chunk_key is None:
            return
        chunk = self.get_chunk(chunk_key)

        if not intra:
            intra = labels.intra_hash_from_children(children)
        while chunk.has_node(intra):
            intra =  (intra + 1) % (2**24)
            
        label = labels.from_chunk_key_and_intra(chunk_key, intra)
        if parent is None:
            parent = self._add_node_recursive(
                self.get_chunk_parent(chunk_key),
                children=[label])

        chunk.add_node(intra, children=children, parent=parent)
        return label

    def add_atomic_node(self, label):
        height, x, y, z , intra = labels.from_label(label)
        if (not self._is_chunk_valid(height, x, y, z)
            or height != 0):
            raise ValueError("Invalid Label")

        self._add_node_recursive(
            labels.to_chunk_key(height, x, y, z),
            intra)
    
    def delete_atomic_edge(self, label_u, label_v):
        if label_u == label_v:
            raise ValueError("We don't allow for self edges")

        height_u, x_u, y_u, z_u, intra_u = labels.from_label(label_u)
        height_v, x_v, y_v, z_v, intra_v = labels.from_label(label_v)

        if height_u != 0 or height_v != 0:
            raise ValueError("Edge can only be deleted between "\
                              "atomic nodes")

        edge = UnorderedPair(label_u, label_v)
        if (x_u, y_u, z_u) != (x_v, y_v, z_v):
            #delete external edge
            self.get_node(label_u).delete_external_edge(edge)
            self.get_node(label_v).delete_external_edge(edge)

        self._delete_edge(label_u, label_v, edge)
         

    def _delete_edge(self, label_u, label_v, edge):
        height_u, x_u, y_u, z_u, intra_u = labels.from_label(label_u)
        height_v, x_v, y_v, z_v, intra_v = labels.from_label(label_v)
        assert height_u == height_v
        if (x_u, y_u, z_u) == (x_v, y_v, z_v):
            chunk = self.get_chunk(
                labels.to_chunk_key(height_u, x_u, y_u, z_u))
            chunk.delete_edge(intra_u, intra_v, edge)

            self._split_node_recursive(label_u, label_v)
        else:
            #the tree we want to delete is higher in the
            #herarchy
            self._delete_edge(self.get_node(label_u).parent,
                              self.get_node(label_v).parent,
                              edge)

    def _split_node_recursive(self, label_u, label_v):
        """
        We just deleted an edge between to nodes,
        this mean they had the same parent.
        We now want to check if their parent have to be split
        into two.
        """
        height_u, x_u, y_u, z_u, intra_u = labels.from_label(label_u)
        height_v, x_v, y_v, z_v, intra_v = labels.from_label(label_v)

        assert (height_u, x_u, y_u, z_u) == (height_v, x_v, y_v, z_v)
        assert self.get_node(label_u).parent == self.get_node(label_v).parent

        #if label_u and label_v are in different connected components
        #we will need to split them
        current_chunk = self.get_chunk(
            labels.to_chunk_key(height_u, x_u, y_u, z_u))
        cc_u = set(current_chunk.get_connected_component(intra_u))
        cc_v = set(current_chunk.get_connected_component(intra_v))
        if cc_u == cc_v:
            # the edge we deleted didn't change the connected
            # componenents so we don't need to modify anything
            return

        parent_chunk_key = self.get_chunk_parent(
                labels.to_chunk_key(height_u, x_u, y_u, z_u))
        parent_chunk = self.get_chunk(parent_chunk_key)

        old_parent  = self.get_node(label_u).parent
        if not old_parent:
            # we are at the higher level of the herarchy
            return 

        parent_parent = self.get_node(old_parent).parent

        self.get_node(label_u).parent = self._add_node_recursive(
            parent_chunk_key, children=cc_u, parent=parent_parent)

        self.get_node(label_v).parent = self._add_node_recursive(
            parent_chunk_key, children=cc_v, parent=parent_parent)

        intra_parent = labels.from_label(old_parent)[-1]
        atomic_edges = parent_chunk.get_node(intra_parent).ext_edges
        atomic_edges.extend(parent_chunk.get_atomic_edges(intra_parent))

        for edge in atomic_edges:
            self.add_atomic_edge(*edge)

        parent_chunk.delete_node(intra_parent)

        self._split_node_recursive(
            self.get_node(label_u).parent,
            self.get_node(label_v).parent)



