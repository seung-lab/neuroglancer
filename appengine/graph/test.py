import unittest
import json
# import server
import time
import shutil

import chunk_io
import labels
from octree import Octree

# class TestHandlers(unittest.TestCase):

#     def test_children(self):
#         request = webapp2.Request.blank(
#             '/v1/graph/mygraph/children/'+str(to_label(1,1,1,1,1)))
#         response = request.get_response(server.app)
#         assert response.status == 404


class TestOctree(unittest.TestCase):

    def setUp(self):
        chunk_io.evict_cache()
        shutil.rmtree('/tmp/graph', ignore_errors=True)

    def test_height(self):
        Octree(size=(1,1,1)).max_height == 0
        Octree(size=(2,1,1)).max_height == 1
        Octree(size=(3,1,1)).max_height == 1
        Octree(size=(4,1,1)).max_height == 2
        Octree(size=(4,4,4)).max_height == 2

    def test_parent(self):
        tree = Octree(size=(4,1,3),path='/tmp/graph/0')

        parent = tree.get_chunk_parent(
            labels.to_chunk_key(0,0,0,0))
        assert parent == labels.to_chunk_key(1,0,0,0)

        # a chunk which is out of bounds in z
        # (z goes from 0 to 2)
        parent = tree.get_chunk_parent(
            labels.to_chunk_key(0,0,0,3))
        assert parent == None

        with self.assertRaises(ValueError):
            #labels doesn't allow negative indexes
            parent = tree.get_chunk_parent(
                labels.to_chunk_key(0,0,0,-1))

    def test_children(self):
        tree = Octree(size=(4,1,3), path='/tmp/graph/0')

        # a chunk at height 0 should have
        # no children
        children = tree.get_chunk_children(
            labels.to_chunk_key(0,0,0,0))
        assert set(children) == set()

        # Trying to get children o a chunk
        # which doesn't exist
        children = tree.get_chunk_children(
            labels.to_chunk_key(5,0,0,0))
        assert set(children) == set()
        children = tree.get_chunk_children(
            labels.to_chunk_key(1,0,2,0))
        assert set(children) == set()

        # because of size this should return
        # 4 children (2,1,2)
        children = tree.get_chunk_children(
            labels.to_chunk_key(1,0,0,0))
        assert set(children) == set(
            [labels.to_chunk_key(0,0,0,0),
             labels.to_chunk_key(0,0,0,1),
             labels.to_chunk_key(0,1,0,0),
             labels.to_chunk_key(0,1,0,1)])

    def test_add_atomic_node(self):
        tree = Octree(size=(4,1,3), path='/tmp/graph/0')
        # check this node doesn't exists
        with self.assertRaises(KeyError):
            tree.get_node(
                labels.to_label(0,0,0,1,1))

        # try adding a node for a chunk that
        # doesn't exists
        label = labels.to_label(10,0,0,0,1)
        with self.assertRaises(ValueError):
            tree.add_atomic_node(label)

        # try adding a negative intra_chunk_id
        with self.assertRaises(ValueError):
            #labels doesn't allow negative indexes
            #if the label is directly provided by the
            #client, make sure to check it is between
            #allowable values before calling add_atomic_node
            tree.add_atomic_node(
                labels.to_label(0,0,0,0,-1))

    def test_chunk_io_cache(self):
        """
        This cache should be able to handle
        many Octrees simultaneusly
        """
        tree = Octree(size=(4,1,3), path='/tmp/graph/0')
        label_u = labels.to_label(0,0,0,0,1)
        tree.add_atomic_node(label_u)

        tree = Octree(size=(4,1,3), path='/tmp/graph/1')
        with self.assertRaises(KeyError):
            tree.get_node(label_u)

    def test_add_atomic_node_hierarchy(self):
        """
        When we add a node to a chunk
        the connected componets of this chunk
        Should have a corresponding node in a chunk
        with heght + 1
        """
        tree = Octree(size=(4,1,3), path='/tmp/graph/0')
        label = labels.to_label(0,0,0,0,1)
        tree.add_atomic_node(label)

        # check the node exists
        assert tree.get_node(label)

        # check parent is correct
        parent_chunk_key = tree.get_chunk_parent(
            labels.to_chunk_key(0,0,0,0))
        chunk = tree.get_chunk(parent_chunk_key)
        parent_intra = chunk._g.nodes()[0]
        parent_label = labels.from_chunk_key_and_intra(
            parent_chunk_key, parent_intra)
        assert len(chunk._g.nodes()) == 1
        assert chunk.get_node(parent_intra).children == [label]
        assert tree.get_node(label).parent == parent_label

    def test_circle(self):
        tree = Octree(size=(2,1,1), path='/tmp/graph/0')

        tree.add_atomic_node(3)
        tree.add_atomic_node(2)
        tree.add_atomic_node(1)

        tree.add_atomic_edge(1,2)
        tree.add_atomic_edge(1,3)
        tree.add_atomic_edge(2,3)

    def test_circle_external_edge(self):
        tree = Octree(size=(1,1,4), path='/tmp/graph/0')

        tree.add_atomic_node(4294967297) # 0, 0, 0, 1, 1
        tree.add_atomic_node(1)          # 0, 0, 0, 0, 1
        tree.add_atomic_node(2)          # 0, 0, 0, 0, 2
        tree.add_atomic_node(3)          # 0, 0, 0, 0, 3

        tree.add_atomic_edge(1,2)
        tree.add_atomic_edge(1,4294967297)
        tree.add_atomic_edge(2,3)
        tree.add_atomic_edge(2,4294967297)

    def test_add_atomic_nodes(self):
        tree = Octree(size=(4,1,3), path='/tmp/graph/0')
        chunk_id = labels.to_chunk_key(0, 1, 0, 1)
        intras = (10,20,42,1337)
        tree.add_atomic_nodes(chunk_id, intras)

        assert tree.get_node(labels.to_label(0, 1, 0, 1, 10))
        assert tree.get_node(labels.to_label(0, 1, 0, 1, 20))
        assert tree.get_node(labels.to_label(0, 1, 0, 1, 42))
        assert tree.get_node(labels.to_label(0, 1, 0, 1, 1337))

        parent_chunk_key = tree.get_chunk_parent(chunk_id)
        parent_chunk = tree.get_chunk(parent_chunk_key)
        parent_labels = [labels.from_chunk_key_and_intra(parent_chunk_key, parent_intra) for parent_intra in parent_chunk._g.nodes()]

        assert len(parent_chunk._g.nodes()) == 4

        assert tree.get_node(labels.to_label(0, 1, 0, 1, 10)).parent in parent_labels
        assert tree.get_node(labels.to_label(0, 1, 0, 1, 20)).parent in parent_labels
        assert tree.get_node(labels.to_label(0, 1, 0, 1, 42)).parent in parent_labels
        assert tree.get_node(labels.to_label(0, 1, 0, 1, 1337)).parent in parent_labels

    def test_add_atomic_edge(self):
        #we don't to check for invalid chunks
        #on a given label because that will
        #raise an Exception when trying to 
        #add the node as showin in
        #test_add_atomic_node

        # check for non existent node
        tree = Octree(size=(4,1,3), path='/tmp/graph/0')
        label_u = labels.to_label(0,0,0,0,1)
        label_v = labels.to_label(0,0,0,0,2)
        with self.assertRaises(KeyError):
            tree.add_atomic_edge(label_u, label_v)
               
        #check for self edge
        tree = Octree(size=(4,1,3), path='/tmp/graph/1')
        label_u = labels.to_label(0,0,0,0,1)
        tree.add_atomic_node(label_u)
        with self.assertRaises(ValueError):
            tree.add_atomic_edge(label_u, label_u)

    def test_add_edge_same_chunk(self):
        #check for edges on the same chunk
        tree = Octree(size=(4,1,3), path='/tmp/graph/0')
        label_u = labels.to_label(0,0,0,0,1)
        label_v = labels.to_label(0,0,0,0,2)
        tree.add_atomic_node(label_u)
        tree.add_atomic_node(label_v)
        tree.add_atomic_edge(label_u, label_v)

        chunk = tree.get_chunk(labels.to_chunk_key(0,0,0,0))

        # edge should be created in the chunk
        assert chunk.get_edge(1,2)

        #the parent of both nodes should now be the same
        assert tree.get_node(label_u).parent ==  tree.get_node(label_v).parent
        # and it should be the only node in this chunk
        assert len(tree.get_chunk(labels.to_chunk_key(1,0,0,0))._g.nodes()) == 1

        # the children of the parent should be the two nodes
        parent = tree.get_node(label_u).parent 
        assert set(tree.get_node(parent).children) == set([label_u, label_v])

        # there should be a single node in the next level as well
        parent_parent = tree.get_node(parent).parent
        chunk = tree.get_chunk(labels.to_chunk_key(2,0,0,0))
        assert len(chunk._g.nodes()) == 1

        #it should have a single children
        tree.get_node(parent_parent).children == [parent]

    def test_add_edge_adjacent_chunks(self):

        #check for edges on adjacent chunks
        tree = Octree(size=(4,1,3), path='/tmp/graph/0')
        label_u = labels.to_label(0,0,0,0,1)
        label_v = labels.to_label(0,0,0,1,2)
        tree.add_atomic_node(label_u)
        tree.add_atomic_node(label_v)
        tree.add_atomic_edge(label_u, label_v)

        #an external edge has to be created for both nodes
        assert len(tree.get_node(label_u).ext_edges) == 1
        assert len(tree.get_node(label_v).ext_edges) == 1

        #there shouldn't be any edge created in either chunk
        #containing the atomic nodes
        assert len(tree.get_chunk(labels.to_chunk_key(0,0,0,0))._g.edges()) == 0
        assert len(tree.get_chunk(labels.to_chunk_key(0,0,0,1))._g.edges()) == 0

        intra_parent_u = labels.from_label(tree.get_node(label_u).parent)[-1]
        intra_parent_v = labels.from_label(tree.get_node(label_v).parent)[-1]

        parent_chunk = tree.get_chunk(labels.to_chunk_key(1,0,0,0))
        assert parent_chunk.get_edge(
            intra_parent_u, intra_parent_v)

        # parent should have the same parents
        assert (parent_chunk.get_node(intra_parent_u).parent ==
                parent_chunk.get_node(intra_parent_u).parent)

    def test_add_edge_far_chunk(self):

        # check as far as possible
        tree = Octree(size=(4,1,3), path='/tmp/graph/0')
        label_u = labels.to_label(0,0,0,0,1)
        label_v = labels.to_label(0,3,0,2,2)
        tree.add_atomic_node(label_u)
        tree.add_atomic_node(label_v)
        tree.add_atomic_edge(label_u, label_v)

        #an external edge has to be created for both nodes
        assert len(tree.get_node(label_u).ext_edges) == 1
        assert len(tree.get_node(label_v).ext_edges) == 1

        #there shouldn't be any edge created in either chunk
        #containing the atomic nodes or it's parents
        assert len(tree.get_chunk(labels.to_chunk_key(0,0,0,0))._g.edges()) == 0
        assert len(tree.get_chunk(labels.to_chunk_key(0,3,0,2))._g.edges()) == 0

        parent_u = tree.get_node(label_u).parent
        parent_v = tree.get_node(label_v).parent
        parent_u_chunk_key = tree.get_chunk_parent(labels.to_chunk_key(0,0,0,0))
        parent_v_chunk_key = tree.get_chunk_parent(labels.to_chunk_key(0,3,0,2))

        assert len(tree.get_chunk(parent_u_chunk_key)._g.edges()) == 0
        assert len(tree.get_chunk(parent_u_chunk_key)._g.edges()) == 0

        # There should be a single node on both chunk parents
        assert len(tree.get_chunk(parent_u_chunk_key)._g.nodes()) == 1
        assert len(tree.get_chunk(parent_u_chunk_key)._g.nodes()) == 1
    
        parent_parent_chunk_key = labels.to_chunk_key(2,0,0,0)
        assert len(tree.get_chunk(parent_parent_chunk_key)._g.edges()) == 1
        assert len(tree.get_chunk(parent_parent_chunk_key)._g.nodes()) == 2

    def test_delete_edge_same_chunk(self):
        tree = Octree(size=(4,1,3), path='/tmp/graph/0')
        label_u = labels.to_label(0,0,0,0,1)
        label_v = labels.to_label(0,0,0,0,2)
        tree.add_atomic_node(label_u)
        tree.add_atomic_node(label_v)
        tree.add_atomic_edge(label_u, label_v)

        tree.delete_atomic_edge(label_u, label_v)
        chunk = tree.get_chunk(
            labels.to_chunk_key(0,0,0,0))

        with self.assertRaises(KeyError):
            chunk.get_edge(1,2)

        #label_u and label_v should now have different parents
        #and its parent should also have different parents
        parent_u = tree.get_node(label_u).parent
        parent_v = tree.get_node(label_v).parent
        assert parent_u != parent_v

        parent_parent_u = tree.get_node(parent_u).parent        
        parent_parent_v = tree.get_node(parent_v).parent
        assert parent_parent_u != parent_parent_v

        #there should be two nodes in the hierarchy
        #and no edges
        label_chunk_key = labels.to_chunk_key(0,0,0,0)
        parent_chunk_key = labels.to_chunk_key(1,0,0,0)
        parent_parent_chunk_key = labels.to_chunk_key(2,0,0,0)

        assert len(tree.get_chunk(label_chunk_key)._g.edges()) == 0
        assert len(tree.get_chunk(label_chunk_key)._g.nodes()) == 2
        assert len(tree.get_chunk(parent_chunk_key)._g.edges()) == 0
        assert len(tree.get_chunk(parent_chunk_key)._g.nodes()) == 2
        assert len(tree.get_chunk(parent_parent_chunk_key)._g.edges()) == 0
        assert len(tree.get_chunk(parent_parent_chunk_key)._g.nodes()) == 2

    def test_delete_edge_adjacent_chunk(self):
        tree = Octree(size=(4,1,3), path='/tmp/graph/0')
        label_u = labels.to_label(0,0,0,0,1)
        label_v = labels.to_label(0,0,0,1,2)
        tree.add_atomic_node(label_u)
        tree.add_atomic_node(label_v)
        tree.add_atomic_edge(label_u, label_v)

        parent_u = tree.get_node(label_u).parent
        parent_v = tree.get_node(label_v).parent
        intra_parent_u = labels.from_label(parent_u)[-1]
        intra_parent_v = labels.from_label(parent_v)[-1]

        assert parent_u != parent_v
        chunk = tree.get_chunk(
                labels.to_chunk_key(1,0,0,0))

        assert chunk.get_edge(intra_parent_u, intra_parent_v)
        tree.delete_atomic_edge(label_u, label_v)

        with self.assertRaises(KeyError):
            chunk.get_edge(intra_parent_u, intra_parent_v)

        #label_v nor label_u should have external edges
        assert len(tree.get_node(label_u).ext_edges) == 0
        assert len(tree.get_node(label_v).ext_edges) == 0

        #label_u and label_v should now have different parents
        #and its parent should also have different parents
        parent_u = tree.get_node(label_u).parent
        parent_v = tree.get_node(label_v).parent
        assert parent_u != parent_v

        parent_parent_u = tree.get_node(parent_u).parent        
        parent_parent_v = tree.get_node(parent_v).parent
        assert parent_parent_u != parent_parent_v

        #there should be two nodes in the hierarchy
        #and no edges
        parent_chunk_key = labels.to_chunk_key(1,0,0,0)
        parent_parent_chunk_key = labels.to_chunk_key(2,0,0,0)
        assert len(tree.get_chunk(parent_chunk_key)._g.edges()) == 0
        assert len(tree.get_chunk(parent_chunk_key)._g.nodes()) == 2
        assert len(tree.get_chunk(parent_parent_chunk_key)._g.edges()) == 0
        assert len(tree.get_chunk(parent_parent_chunk_key)._g.nodes()) == 2

    def test_delete_edge_far_chunk(self):

        tree = Octree(size=(4,1,3), path='/tmp/graph/0')
        label_u = labels.to_label(0,0,0,0,1)
        label_v = labels.to_label(0,3,0,2,2)
        tree.add_atomic_node(label_u)
        tree.add_atomic_node(label_v)
        tree.add_atomic_edge(label_u, label_v)

        parent_u = tree.get_node(label_u).parent
        parent_v = tree.get_node(label_v).parent        
        assert parent_u != parent_v

        parent_parent_u = tree.get_node(parent_u).parent        
        parent_parent_v = tree.get_node(parent_v).parent
        assert parent_parent_u != parent_parent_v

        intra_parent_parent_u = labels.from_label(parent_parent_u)[-1]        
        intra_parent_parent_v = labels.from_label(parent_parent_v)[-1]
        assert parent_parent_u != parent_parent_v


    def test_3_node_delete(self):
        """
        1)
        I first add nodes 1,2,3
                                +-----------+
                                |           |
                                |           |
                                |           |
                                |           |
                                |           |
                                +-----------+
                +-----------+                  +-----------+
                |           |                  |           |
                |           |                  |           |
                |           |                  |           |
                |           |                  |           |
                |           |                  |           |
                +-----------+                  +-----------+

        +-----------+   +-----------+  +-----------+   +-----------+
        |           |   |           |  |           |   |           |
        |           |   |           |  |           |   |           |
        |    1      |   |     2     |  |           |   |     3     |
        |           |   |           |  |           |   |           |
        |           |   |           |  |           |   |           |
        +-----------+   +-----------+  +-----------+   +-----------+
        
        2)
        I later add atomic edges between 1-2, and 2-3 this will look like

                                +-----------+
                                |           |
                                |           |
                      +-----------6[----]7-----------+
                      |         |           |        |
                      |         |           |        |
                      |         +-----------+        |
                +-----------+                  +-----------+
                |     |     |                  |     |     |
                |     v     |                  |     v     |
             +--------4-------+                |     5-------+
             |  |           | |                |           | |
             |  |           | |                |           | |
             |  +-----------+ |                +-----------+ |
             |                |                              |
        +-----------+   +-----------+  +-----------+   +-----------+
        |    |      |   |     |     |  |           |   |     |     |
        |    v      |   |     v     |  |           |   |     v     |
        |    1|--------------|2|----------------------------|3     |
        |           |   |           |  |           |   |           |
        |           |   |           |  |           |   |           |
        +-----------+   +-----------+  +-----------+   +-----------+

        where |--| means external edge
              [--] intra chunk edge
              ---> parent to children arrow
        
        3)
        The goal is to now delete the atomic edge 1-2
        Which should produce something like
                                +-----------+
                                |           |
                                |           |
                   +--------------9  6[--]7----------+
                   |     +-----------+      |        |
                   |     |      |           |        |
                   |     |      +-----------+        |
                +-----------+                  +-----------+
                |  |     |  |                  |     |     |
                |  v     v  |                  |     v     |
             +-----8     4----+                |     5-------+
             |  |           | |                |           | |
             |  |           | |                |           | |
             |  +-----------+ |                +-----------+ |
             |                |                              |
        +-----------+   +-----------+  +-----------+   +-----------+
        |    |      |   |     |     |  |           |   |     |     |
        |    v      |   |     v     |  |           |   |     v     |
        |    1      |   |     2|----------------------------|3     |
        |           |   |           |  |           |   |           |
        |           |   |           |  |           |   |           |
        +-----------+   +-----------+  +-----------+   +-----------+

        """
        tree = Octree(size=(1,1,4), path='/tmp/graph/0')

        #1)
        label_1 = labels.to_label(0,0,0,0,1)
        label_2 = labels.to_label(0,0,0,1,2)
        label_3 = labels.to_label(0,0,0,3,3)
        tree.add_atomic_node(label_1)
        tree.add_atomic_node(label_2)
        tree.add_atomic_node(label_3)

        #2)
        tree.add_atomic_edge(label_1, label_2)
        tree.add_atomic_edge(label_2, label_3)

        #3)
        tree.delete_atomic_edge(label_1, label_2)

        assert len(tree.get_node(label_1).ext_edges) == 0
        assert len(tree.get_node(label_2).ext_edges) == 1
        assert len(tree.get_node(label_3).ext_edges) == 1

        assert (tree.get_node(label_1).parent !=
                tree.get_node(label_2).parent)

        parent_parent_1 = tree.get_node(tree.get_node(label_1).parent).parent
        parent_parent_2 = tree.get_node(tree.get_node(label_2).parent).parent
        parent_parent_3 = tree.get_node(tree.get_node(label_3).parent).parent

        assert parent_parent_1 != parent_parent_2
        assert parent_parent_2 != parent_parent_3
        assert parent_parent_1 != parent_parent_3


        parent_parent_chunk = tree.get_chunk(
            labels.to_chunk_key(2,0,0,0))
        assert parent_parent_chunk.get_edge(
            labels.from_label(parent_parent_2)[-1],
            labels.from_label(parent_parent_3)[-1])
