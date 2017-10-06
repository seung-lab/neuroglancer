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

from __future__ import absolute_import

import collections
import io
import six
import struct

import numpy as np

class Skeleton(object):
    def __init__(self, vertex_positions, edges, vertex_attributes=None):
        self.vertex_positions = np.array(vertex_positions, dtype='<f4')
        self.edges = np.array(edges, dtype='<u4')
        self.vertex_attributes = vertex_attributes

    def encode(self, source=None):
        result = io.BytesIO()
        edges = self.edges
        vertex_positions = self.vertex_positions
        vertex_attributes = self.vertex_attributes
        result.write(struct.pack('<II', vertex_positions.shape[0], edges.shape[0] // 2))
        result.write(vertex_positions.tobytes())
        if source and len(source.vertex_attributes) > 0:
            for name, info in six.iteritems(source.vertex_attributes):

                attribute = np.array(vertex_attributes[name],
                                     np.dtype(info.data_type).newbyteorder('<'))
                expected_shape = (vertex_positions.shape[0], info.num_components)
                if (attribute.shape[0] != expected_shape[0] or
                        attribute.size != np.prod(expected_shape)):
                    raise ValueError('Expected attribute %r to have shape %r, but was: %r' %
                                     (name, expected_shape, attribute.shape))
                result.write(attribute.tobytes())
        result.write(edges.tobytes())
        return result.getvalue()


VertexAttributeInfo = collections.namedtuple('VertexAttributeInfo', ['data_type', 'num_components'])

class SkeletonSource(object):

    def __init__(self):
        self.vertex_attributes = collections.OrderedDict()

    def get_skeleton(self, object_id):
        """Retrieves the skeleton corresponding to the specified `object_id`.

        @param object_id: uint64 object id.

        @returns The Skeleton object representing the skeleton, or `None` if there is no
            corresponding skeleton.
        """
        raise NotImplementedError

    def get_vertex_attributes_spec(self):
        temp = collections.OrderedDict()
        for k, v in six.iteritems(self.vertex_attributes):
            temp[k] = dict(dataType=np.dtype(v.data_type).name, numComponents=v.num_components)
        return temp

if __name__ == '__main__':
    # example on how to write an skeleton to disk
    with open('/tmp/3','w') as f:
        vertices = [[0.0,0.0,0.0],[1000.0, 0.0,0.0],[1000.0, 1000.0, 0.0],[0.0, 1000.0,0.0]]
        edges = [0,1,1,2,2,3,3,0]
        content = Skeleton(vertices, edges).encode()
        f.write(content)
