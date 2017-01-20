import json

import networkx as nx
from tornado.testing import AsyncHTTPTestCase

from graph_server import make_app

class BaseTestCase(AsyncHTTPTestCase):
    def get_app(self):
        self.app =  make_app(test=True)
        return self.app

    def tearDown(self):
        self.app.args['G'] = nx.Graph()
        del self.app.args['sets'][:]

    @property
    def G(self):
        return self.app.args['G']

    @G.setter
    def G(self, value): 
        self.app.args['G'] = value

    def check_get_object(self, arr):
        self.http_client.fetch(
            self.get_url('/1.0/object/'),
            self.stop,
            method="GET"
        )
        response = self.wait()
        self.assertEquals(json.loads(response.body), arr)

    def check_post_object(self, arr):
        self.http_client.fetch(
            self.get_url('/1.0/object/'),
            self.stop,
            body=json.dumps(arr),
            method="POST"
        )
        response = self.wait()
        self.assertEqual(response.code, 200)

class TestSplitHandler(BaseTestCase):
    
    def test_split_center(self):
        self.check_post_object([1,2,3,4])
        self.G.add_edge(1,2,capacity=0.5)
        self.G.add_edge(2,3,capacity=0.1)
        self.G.add_edge(3,4,capacity=0.5)

        self.http_client.fetch(
            self.get_url('/1.0/split/1/4'),
            self.stop,
            body='',
            method="POST"
        )
        response = self.wait()
        self.assertEqual(response.code, 200)
        self.assertEqual(json.loads(response.body),[[1,2],[3,4]])

    def test_split_side(self):
        self.check_post_object([1,2,3,4])
        self.G.add_edge(1,2,capacity=0.5)
        self.G.add_edge(2,3,capacity=0.8)
        self.G.add_edge(3,4,capacity=0.5)

        self.http_client.fetch(
            self.get_url('/1.0/split/1/4'),
            self.stop,
            body='',
            method="POST"
        )
        response = self.wait()
        self.assertEqual(response.code, 200)

        left = json.loads(response.body) == [[1,2,3],[4]]
        right = json.loads(response.body) == [[1],[2, 3, 4]]
        self.assertTrue(left or right)

    def test_split_outsider(self):
        self.check_post_object([1,2,3,4])
        self.G.add_edge(1,2,capacity=0.5)
        self.G.add_edge(2,3,capacity=0.8)
        self.G.add_edge(3,4,capacity=0.5)

        self.http_client.fetch(
            self.get_url('/1.0/split/1/8'), #8 is not inside object
            self.stop,
            body='',
            method="POST"
        )
        response = self.wait()
        self.assertEqual(response.code, 400)


class TestObjectHandler(BaseTestCase):

    def test_empty(self):
        self.check_post_object([])

    def test_insertion(self):
        self.check_post_object([1,2,3])
        self.check_get_object([[1,2,3]])

        # adds the same stuff once again
        self.check_post_object([1,2,3])
        self.check_get_object([[1,2,3]])

        # adds an independent objects
        self.check_post_object([4,5,6])
        self.check_get_object([[1,2,3],[4,5,6]])

        # adds another set that merges the two objects from before
        self.check_post_object([5,6,1,7])
        self.check_get_object([[1,2,3,4,5,6,7]])
