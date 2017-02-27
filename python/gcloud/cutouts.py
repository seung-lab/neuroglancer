import os
import sys
import h5py
import numpy as np
from tqdm import tqdm

import neuroglancer

from lib import list_shape, xyzrange, Vec3, Bbox, map2, min2, max2

from enum import Enum

class FileTypes(Enum):
    HDF5 = 1,
    NPZ = 2

class CircularImageCache(object):

    def __init__(self, shape = Vec3(2048, 2048, 256), dtype=np.uint32):
        self.buffer = np.zeros(shape=shape.astype(int), dtype=dtype)
        self.offset = Vec3(0,0,0) 
        self.clean = True

    def clear(self):
        self.buffer.fill(0)
        self.offset = Vec3(0,0,0)
        self.clean = True

    def blackRatio(self):
        """For debugging. Tells you how much is unfilled."""
        nonzeros = np.count_nonzero(self.buffer)
        total_size = Vec3(*self.buffer.shape).rectVolume()

        return 1.0 - (float(nonzeros) / float(total_size))

    def move(self, delta):
        self.offset = np.mod(self.offset + delta, self.buffer.shape)

    def read(self, shape, offset = (0,0,0)):
        databox = Bbox.from_vec(shape)
        bufferbox = Bbox.from_vec(self.buffer.shape)

        assert bufferbox.containsBbox(databox), "data shape ({}) is larger than the buffer ({})".format(databox, bufferbox)

        startpt = self.offset + Vec3(*offset)
        endpt = startpt + Vec3(*shape)
        
        bufsize = Vec3(*self.buffer.shape)

        # very fast path (seconds)
        if all(np.absolute(endpt - startpt) < bufsize) and all(startpt > endpt):
            return self.buffer[ startpt.x:endpt.x, startpt.y:endpt.y, startpt.z:endpt.z ]
        else: # very slow path (~30 min)
            readbuffer = np.empty(shape=shape)

            for pt in xyzrange(startpt, endpt):
                readbuffer[ tuple((pt - startpt).astype(int)) ] = self.buffer[ tuple(np.mod(pt, bufsize).astype(int)) ]

            return readbuffer

    def write(self, data, offset = (0,0,0)):
        databox = Bbox.from_vec(data.shape)
        bufferbox = Bbox.from_vec(self.buffer.shape)

        assert bufferbox.containsBbox(databox), "data shape ({}) is larger than the buffer ({})".format(databox, bufferbox)

        bufsize = Vec3(*self.buffer.shape)

        startpt = ( self.offset + Vec3(*offset) )
        endpt = ( startpt + Vec3(*data.shape) )

        total_delta = endpt - startpt
        startpt = np.mod(startpt, bufsize).astype(int)
        endpt = (startpt + total_delta).astype(int)

        # only handles modulo along a single dimension at a time
        # there's a partial version of multiple axis modulo in git history
        # that you can try completing if necessary. Need to cover xy, xz, zy, xyz

        # tried using just modulo arithmatic but it was too slow by orders of magnitude 
        # see read for an example. Now manually computes reflections and uses vectorized instructions

        # inside
        insidept = Vec3(*min2(endpt, bufsize).astype(int))
        inside_delta = (insidept - startpt).astype(int)

        self.buffer[ startpt.x:insidept.x, startpt.y:insidept.y, startpt.z:insidept.z ] = data[ :inside_delta.x, :inside_delta.y, :inside_delta.z]

        # x reflection
        xpt = Vec3(endpt.x, insidept.y, insidept.z)
        x_delta = xpt - startpt - inside_delta
        self.buffer[ 0:x_delta.x, startpt.y:insidept.y, startpt.z:insidept.z ] = data[ inside_delta.x:(inside_delta.x + x_delta.x), :inside_delta.y, :inside_delta.z ]

        # y reflection
        ypt = Vec3(insidept.x, endpt.y, insidept.z)
        y_delta = ypt - startpt - inside_delta
        self.buffer[ startpt.x:insidept.x, 0:y_delta.y, startpt.z:insidept.z ] = data[ :inside_delta.x, inside_delta.y:(inside_delta.y + y_delta.y), :inside_delta.z ]

        lowstartpt = Vec3(startpt.x, startpt.y, insidept.z)

        # z reflection 
        zpt = Vec3(insidept.x, endpt.y, endpt.z)
        z_delta = zpt - lowstartpt
        self.buffer[ startpt.x:insidept.x, startpt.y:insidept.y, 0:z_delta.z ] = data[ :inside_delta.x, :inside_delta.y, inside_delta.z:(inside_delta.z + z_delta.z) ]


class Volume(object):

    def __init__(self, filebboxlist, filetype):
        """filebboxlist = [ ( filename, (np.array(x,y,z), np.array(x,y,z)) ), ... ]"""

        assert isinstance(filetype, FileTypes)

        self.filetype = filetype
        self.bbox = self.__compute_global_bbox([ bbox for filename, bbox in filebboxlist ])
        
        # assume each chunk is the same size, this allows us to make many simplifiying 
        # assumptions. If we can't make this assumption, we should use a region tree
        
        first_tuple = filebboxlist[0][1]

        self.file_chunk_size = Bbox(first_tuple[0], first_tuple[1]).size3()

        grid_dimensions = np.ceil(self.bbox.size3() / self.file_chunk_size).astype(int)
        self.chunk_filenames = list_shape(grid_dimensions, '')

        for filename, bbox in filebboxlist:
            x,y,z = np.floor(np.array(bbox[0]) / self.file_chunk_size).astype(int)
            self.chunk_filenames[x][y][z] = filename

        self.__BLACK_BLOCK = np.zeros(shape=self.file_chunk_size)

    def __compute_global_bbox(self, bbox_tuples):
        if len(bbox_tuples) == 0:
            return Bbox( (0,0,0), (1,1,1) )

        world_min, world_max = bbox_tuples[0]

        # a bbox = ( (x,y,z), (x,y,z) ) = (minpt, maxpt)
        for bbox in bbox_tuples:
            minpt, maxpt = bbox

            world_min[0] = min(world_min[0], minpt[0])
            world_min[1] = min(world_min[1], minpt[1])
            world_min[2] = min(world_min[2], minpt[2])

            world_max[0] = max(world_max[0], maxpt[0])
            world_max[1] = max(world_max[1], maxpt[1])
            world_max[2] = max(world_max[2], maxpt[2])

        return Bbox(world_min, world_max)
    
    @property
    def shape():
        return self.global_bbox.size3()

    def readImageAt(self, x, y, z):
        try:
            filename = self.chunk_filenames[x][y][z]
            if filename == '':
                return self.__BLACK_BLOCK

            img = self.readImageFile(filename, self.filetype)
            return img.T # z,y,x to x,y,z
        except IndexError:
            return self.__BLACK_BLOCK

    def readImageFile(self, filename, filetype):
        if filetype is None:
            return numpy.empty(self.file_chunk_size)
        elif filetype == FileTypes.HDF5:
            with h5py.File(filename, 'r') as chunkfile:
                img = chunkfile['main'][:]
            return img
        elif filetype == FileTypes.NPZ:
            return neuroglancer.chunks.decode_npz(filename)
        else:
            raise NotImplementedError("{} is not a supported file type.", filetype)

    def writeImageFile(self, filename, filetype, data):
        if filetype is None:
            return
        elif filetype is FileTypes.HDF5:
            with h5py.File(filename, 'w') as chunkfile:
                chunkfile['main'] = data
        elif filetype is FileTypes.NPZ:
            with open(filename, 'w') as chunkfile:
                chunkfile.write( neuroglancer.chunks.encode_npz(data) )
        else:
            raise NotImplementedError("{} is not a supported file type.", filetype)
    
    def cutout(self, window):
        """window is a Bbox"""

        # +2 to provide border for meshing
        n_chunks = np.ceil( (window.size3() + 2) / self.file_chunk_size )

        imagecache = CircularImageCache( n_chunks * self.file_chunk_size )

        startpt = np.floor((window.minpt - 1) / self.file_chunk_size) # -1 to provide 1px border

        for point in xyzrange(n_chunks):
            grid_index = startpt + point
            img = self.readImageAt(*grid_index)
            imagecache.write(img, self.file_chunk_size * grid_index + 1)

        return imagecache.read(window.size3() + 2, window.minpt - 1)

    def totalChunks(self, chunksize):
        return np.ceil(self.bbox.size3() / chunksize)

    def filesPerChunk(self, chunksize):
        return np.ceil(chunksize / self.file_chunk_size) # for s1 this should be <1,1,1>

    def initializeCache(self, chunksize):
        
        total_chunks = self.totalChunks(chunksize)
        files_per_chunk = self.filesPerChunk(chunksize)

        # up to 27 chunks will be read into memory. 
        # @ 1024x1024x128 voxels 
        # uint32 = 13.8 GB, uint16 = 6.9 GB, uint8 = 3.5 GB
        imagecache = CircularImageCache(files_per_chunk * self.file_chunk_size * 3, dtype=np.uint32) 
        imagecache.move(files_per_chunk) # top back and left are black, paint rest

        two_chunks = files_per_chunk * Vec3(2,2,2)

        initial_population = min2(total_chunks, two_chunks)

        for x,y,z in xyzrange( initial_population ):
            img = self.readImageAt(x,y,z)
            
            if img is self.__BLACK_BLOCK:
                continue
            
            print x,y,z
            imagecache.write(img, self.file_chunk_size * Vec3(x,y,z))

        return imagecache

    def __advanceCache(self, imagecache, chunksize, position, delta):

        new_position = position + delta

        imagecache.move(delta * chunksize)

        files_per_chunk = self.filesPerChunk(chunksize)

        start = Vec3.triple(-1) * files_per_chunk
        end = Vec3.triple(1) * files_per_chunk
        
        for file_pt in xyzrange( start, end ):
            file_pt[delta != 0] = 0
            
            offset = new_position + file_pt

            img = self.readImageAt(*offset)

            imagecache.write(img, offset * self.file_chunk_size)


    def generateChunks(self, chunksize):
        chunksize = Vec3(*chunksize)

        imagecache = self.initializeCache(chunksize)

        last_chunk = Vec3(-1, 0, 0)
        start_bbox = Bbox( self.bbox.minpt - 1, self.bbox.minpt + chunksize + 1 )

        for chunk in descendingChunkSequence(self.totalChunks(chunksize)):
            img = imagecache.read(chunksize + 2, (-1, -1, -1))
            yield [ img, start_bbox + chunksize * chunk ]

            delta = chunk - last_chunk
            last_chunk = chunk

            self.__advanceCache(imagecache, chunksize, chunk, delta)


def descendingChunkSequence(total_chunks):
    """spiral inward, descend 1 z, spiral outward to start, descend 1 z, spiral inward...."""
    
    total_chunks = total_chunks.astype(int)

    spiral = [ pt for pt in spiralSequence(total_chunks.x, total_chunks.y) ]

    for z in xrange(total_chunks.z):
        for pt in spiral:
            tmp = pt.clone()
            tmp.z = z
            yield tmp

        spiral.reverse()

def spiralSequence(width, height):
    """Generate a clockwise spiral around a 2D rectangular grid. 
       Outputs Vec3s, but only x and y are used.

       e.g. 3x3:

        |  1 | 2  | 3  |
        |  8 | 9  | 4  | 
        |  7 | 6  | 5  |
    """

    if width == 0 or height == 0:
        return ( _ for _ in () )
    if width == 1:
        return ( Vec3(0, i, 0) for i in xrange(height))
    elif height == 1:
        return ( Vec3(i, 0, 0) for i in xrange(width))

    def clockwise_spiral():
        # Ignore z, didn't want to duplicate code to make a Vec2
        # All of these Vec3s could be Vec2s
        bounds = Vec3(width, height - 1, 0)
        direction = Vec3(1, 0, 0) 
        pt = Vec3(0,0,0) # Really a Vec2
        bound_idx = 0
        steps = 1

        total_squares = width * height
        covered = 0

        while covered < total_squares:
            yield pt.clone()
            
            pt += direction
            steps += 1            
            covered += 1
            
            if steps == bounds[bound_idx]:
                steps = 0
                bounds[bound_idx] -= 1
                bound_idx = (bound_idx + 1) % 2
                direction = Vec3( -direction.y, direction.x, 0 )

    return clockwise_spiral()


files = [
    ['../snemi3d/machine_labels.h5', [ Vec3(0,0,0), Vec3(1024, 1024, 128) ] ]
]

vol = Volume(files, FileTypes.HDF5)

for img, bbox in vol.generateChunks(Vec3(1024, 1024, 128)):
    # vol.writeImageFile('./test.h5', FileTypes.HDF5, img)
    print img.shape, bbox










