# @license
# Copyright 2016 Google Inc.
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

from __future__ import absolute_import, print_function
import threading
import json
import socket
import re

import tornado.ioloop
import tornado.web
from sockjs.tornado import SockJSRouter, SockJSConnection

from .token import make_random_token
from . import static
from . import volume

global_static_content_source = None
global_server_args = dict(bind_address='127.0.0.1', bind_port=8000)
global_server = None
debug = True


class BaseHandler(tornado.web.RequestHandler):

    def initialize(self, server):
        self.server = server

class VolumeHandler(BaseHandler):
    def get(self, token, path):
        vol = self.server.volumes.get(token)
        if vol is None:
            self.set_status(404)
            return
        vol.handle_request(path, self)

class StaticHandler(BaseHandler):
    def get(self, token, path):
        if token != self.server.token:
            self.set_status(404)

        try:
            data, content_type = global_static_content_source.get(path)
        except ValueError as e:
            self.set_status(404)
            return
        self.set_status(200)
        self.set_header('Content-type', content_type)
        self.set_header('Content-length', len(data))
        self.finish(data)

class StateHandler(SockJSConnection):
    clients = set()
    last_state = None

    def on_open(self, info):
        # When new client comes in, will add it to the clients list
        self.clients.add(self)

       
    def on_message(self, msg):
        state = json.loads(msg)
        if not self.last_state:
            new_state = global_server.viewer.initialize_state(state)
            if new_state:
                self.broadcast(self.clients, json.dumps(new_state))
                state = new_state
        else:
            new_state = global_server.viewer.on_state_changed(state) 
            if new_state:
                self.broadcast(self.clients, json.dumps(new_state))
                state = new_state

        self.last_state = state

    def on_close(self):
        # If client disconnects, remove him from the clients list
        self.clients.remove(self)
        global_server.viewer.on_close(self.last_state)

class Server(object):
    def __init__(self, viewer, bind_address='127.0.0.1', bind_port=8000):
        self.daemon_threads = True
        self.volumes = dict()
        self.token = make_random_token()
        self.viewer = viewer
        global global_static_content_source
        if global_static_content_source is None:
            global_static_content_source = static.get_default_static_content_source()

        self.server_url = 'http://%s:%s' % (bind_address, bind_port)
        
        StateRouter = SockJSRouter(StateHandler, '/state')

        app = tornado.web.Application([
        (r'^/neuroglancer/([^/]+)/(.*)/?$', VolumeHandler, {'server': self}),
        (r'^/static/([^/]+)/((?:[a-zA-Z0-9_\-][a-zA-Z0-9_\-.]*)?)$', StaticHandler, {'server': self})
        ] + StateRouter.urls , debug=debug)
        app.listen(port=bind_port, address=bind_address)
        self.loop = tornado.ioloop.IOLoop.current()


def set_static_content_source(*args, **kwargs):
    global global_static_content_source
    global_static_content_source = static.get_static_content_source(*args, **kwargs)

def set_server_bind_address(bind_address='127.0.0.1', bind_port=8000):
    global global_server_args
    global_server_args = dict(bind_address=bind_address, bind_port=bind_port)

def is_server_running():
    return global_server is not None

def stop():
    """Stop the server, invalidating any viewer URLs.

    This allows any previously-referenced data arrays to be garbage collected if there are no other
    references to them.
    """
    global global_server
    if global_server is not None:
        global_server.loop.stop()
        global_server = None

def get_server_url():
    return global_server.server_url

def start(viewer):
    global global_server
    if global_server is None:
        global_server = Server(viewer=viewer, **global_server_args)
        thread = threading.Thread(target=global_server.loop.start)
        thread.daemon = True
        thread.start()

def register_volume(volume):
    global_server.volumes[volume.token] = volume
