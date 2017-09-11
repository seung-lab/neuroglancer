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
import sys

try:
    # Python 2 case
    from SocketServer import ThreadingMixIn  # pylint: disable=import-error
    from BaseHTTPServer import HTTPServer, BaseHTTPRequestHandler  # pylint: disable=import-error
except ImportError:
    # Python 3 case
    from socketserver import ThreadingMixIn  # pylint: disable=import-error
    from http.server import HTTPServer, BaseHTTPRequestHandler  # pylint: disable=import-error

import threading
import re
import json
import socket
from .randomtoken import make_random_token
from . import static
from . import volume

INFO_PATH_REGEX = re.compile(r'^/neuroglancer/info/([^/]+)$')

DATA_PATH_REGEX = re.compile(
    r'^/neuroglancer/([^/]+)/([^/]+)/([^/]+)/([0-9]+),([0-9]+)/([0-9]+),([0-9]+)/([0-9]+),([0-9]+)$')
thread = None

MESH_PATH_REGEX = re.compile(r'^/neuroglancer/mesh/([^/]+)/([0-9]+)$')

SKELETON_PATH_REGEX = re.compile(r'^/neuroglancer/skeleton/([^/]+)/([0-9]+)$')

STATIC_PATH_REGEX = re.compile(r'/static/([^/]+)/((?:[a-zA-Z0-9_\-][a-zA-Z0-9_\-.]*)?)$')

global_static_content_source = None

global_server_args = dict(bind_address='127.0.0.1', bind_port=0)

debug = False

class Server(ThreadingMixIn, HTTPServer):
    def __init__(self, bind_address='127.0.0.1', bind_port=0):
        HTTPServer.__init__(self, (bind_address, bind_port), RequestHandler)
        self.daemon_threads = True
        self.volumes = dict()
        self.token = make_random_token()
        global global_static_content_source
        if global_static_content_source is None:
            global_static_content_source = static.get_default_static_content_source()

        if bind_address == '0.0.0.0':
            hostname = socket.getfqdn()
        else:
            hostname = bind_address
        self.server_url = 'http://%s:%s' % (hostname, self.server_address[1])

    def handle_error(self, request, client_address):
        if debug:
            HTTPServer.handle_error(self, request, client_address)

class RequestHandler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def do_GET(self):  # pylint: disable=invalid-name
        m = re.match(DATA_PATH_REGEX, self.path)
        if m is not None:
            self.handle_data_request(token=m.group(2),
                                     data_format=m.group(1),
                                     scale_key=m.group(3),
                                     start=(int(m.group(4)), int(m.group(6)), int(m.group(8))),
                                     end=(int(m.group(5)), int(m.group(7)), int(m.group(9))))
            return
        m = re.match(MESH_PATH_REGEX, self.path)
        if m is not None:
            self.handle_mesh_request(m.group(1), int(m.group(2)))
            return
        m = re.match(SKELETON_PATH_REGEX, self.path)
        if m is not None:
            self.handle_skeleton_request(m.group(1), int(m.group(2)))
            return
        m = re.match(INFO_PATH_REGEX, self.path)
        if m is not None:
            self.handle_info_request(m.group(1))
            return
        m = re.match(STATIC_PATH_REGEX, self.path)
        if m is not None:
            self.handle_static_request(m.group(1), m.group(2))
            return
        self.send_error(404)

    def handle_static_request(self, token, path):
        if token != self.server.token:
            self.send_error(404)
        try:
            data, content_type = global_static_content_source.get(path)
        except ValueError as e:
            self.send_error(404, e.args[0])
            return

        self.send_response(200)
        self.send_header('Content-type', content_type)
        self.send_header('Content-length', len(data))
        self.end_headers()
        self.wfile.write(data)

    def handle_data_request(self, token, scale_key, data_format, start, end):  # pylint: disable=redefined-outer-name
        vol = self.server.volumes.get(token)
        if vol is None:
            self.send_error(404)
            return
        try:
            data, content_type = vol.get_encoded_subvolume(
                data_format, start, end, scale_key=scale_key)
        except ValueError as e:
            self.send_error(400, e.args[0])
            return

        self.send_response(200)
        self.send_header('Content-type', content_type)
        self.send_header('Content-length', len(data))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(data)

    def handle_info_request(self, token):
        vol = self.server.volumes.get(token)
        if vol is None:
            self.send_error(404)
            return
        data = json.dumps(vol.info())
        self.send_response(200)
        self.send_header('Content-type', 'application/json')
        self.send_header('Content-length', len(data))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(data)

    def handle_mesh_request(self, key, object_id):
        vol = self.server.volumes.get(key)
        if vol is None:
            self.send_error(404)
        try:
            encoded_mesh = vol.get_object_mesh(object_id)
        except volume.MeshImplementationNotAvailable:
            self.send_error(501, 'Mesh implementation not available')
            return
        except volume.MeshesNotSupportedForVolume:
            self.send_error(405, 'Meshes not supported for volume')
            return
        except volume.InvalidObjectIdForMesh:
            self.send_error(404, 'Mesh not available for specified object id')
            return
        except ValueError as e:
            self.send_error(400, e.args[0])
            return
        self.send_response(200)
        self.send_header('Content-type', 'application/octet-stream')
        self.send_header('Content-length', len(encoded_mesh))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(encoded_mesh)

    def handle_skeleton_request(self, key, object_id):
        vol = self.server.volumes.get(key)
        if vol is None:
            self.send_error(404)
        if vol.skeletons is None:
            self.send_error(405, 'Skeletons not supported for volume')
            return

        skeleton = vol.skeletons.get_skeleton(object_id)
        if skeleton is None:
            self.send_error(404, 'Skeleton not available for specified object id')
            return
        encoded_skeleton = skeleton.encode(vol.skeletons)

        self.send_response(200)
        self.send_header('Content-type', 'application/octet-stream')
        self.send_header('Content-length', len(encoded_skeleton))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(encoded_skeleton)

    def log_message(self, format, *args):
        if debug:
            BaseHTTPRequestHandler.log_message(self, format, *args)

global_server = None


def set_static_content_source(*args, **kwargs):
    global global_static_content_source
    global_static_content_source = static.get_static_content_source(*args, **kwargs)


def set_server_bind_address(bind_address='127.0.0.1', bind_port=0):
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
        global_server.shutdown()
        global_server = None


def get_server_url():
    return global_server.server_url


def start():
    global global_server
    global thread

    if global_server is None:
        global_server = Server(**global_server_args)
        thread = threading.Thread(target=global_server.serve_forever)
        thread.daemon = True
        thread.start()

def block():
    global thread
    if thread:
        while True:
            thread.join(600)
            if not thread.isAlive():
                break


def register_volume(volume):
    start()
    global_server.volumes[volume.token] = volume
