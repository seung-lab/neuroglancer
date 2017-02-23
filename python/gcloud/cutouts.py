import os
import sys
import h5py
import numpy as np

import neuroglancer

from lib import list_shape, xyzrange, Vec3, Bbox, map2, min2, max2

from enum import Enum

class FileTypes(Enum):
    HDF5,
    NPZ

class CircularImageCache(object):

    def __init__(self, shape = Vec3(2048, 2048, 256), dtype=np.uint32):
        self.buffer = np.zeros(shape=shape, dtype=dtype)
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

        assert(bufferbox.containsBbox(databox), "data shape ({}) is larger than the buffer ({})".format(databox, bufferbox))

        startpt = self.offset + Vec3(*offset)
        endpt = startpt + Vec3(*databox.shape)
        
        readbuffer = np.zeros(shape=shape)

        bufsize = Vec3(*self.buffer.shape)

        for pt in xyzrange(startpt, endpt + 1):
            readbuffer[ tuple(pt - startpt) ] = self.buffer[ tuple(np.mod(pt, bufsize)) ]

        return readbuffer

    def write(self, data, offset = (0,0,0)):
        databox = Bbox.from_vec(data.shape)
        bufferbox = Bbox.from_vec(self.buffer.shape)

        assert(bufferbox.containsBbox(databox), "data shape ({}) is larger than the buffer ({})".format(databox, bufferbox))

        startpt = self.offset + Vec3(*offset)
        endpt = startpt + Vec3(*data.shape)

        bufsize = Vec3(*self.buffer.shape)

        for pt in xyzrange(startpt, endpt + 1):
            self.buffer[ tuple(np.mod(pt, bufsize)) ] = data[ tuple(pt - startpt) ]

class Volume(object):

    def __init__(self, filebboxlist, filetype):
        """filebboxlist = [ ( filename, (np.array(x,y,z), np.array(x,y,z)) ), ... ]"""

        assert(isinstance(filetype, FileTypes))

        self.filetype = filetype
        self.bbox = self.__compute_global_bbox([ bbox for filename, bbox in filebboxlist ])
        
        # assume each chunk is the same size, this allows us to make many simplifiying 
        # assumptions. If we can't make this assumption, we should use a region tree
        
        first_tuple = filebboxlist[0][1]

        bbox = Bbox(first_tuple[0], first_tuple[1])
        self.file_chunk_size = bbox.size3()

        grid_dimensions = np.ceil(self.global_bbox.size3() / self.file_chunk_size)

        self.chunk_filenames = list_shape(grid_dimensions, '')

        for filename, bbox in filebboxlist:
            x,y,z = np.floor(np.array(bbox[0]) / self.file_chunk_size)
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

            return self.readImageFile(filename, self.filetype)
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

        two_chunks = files_per_chunk * Vec(2,2,2)

        initial_population = min2(total_chunks, two_chunks)

        for x,y,z in xyzrange( initial_population ):
            img = self.readImageAt(x,y,z)
            
            if img is self.__BLACK_BLOCK:
                continue
            
            imagecache.write(img, self.file_chunk_size * Vec3(x,y,z))

        return imagecache

    def __advanceCache(self, imgcache, chunksize, position, delta):

        new_position = position + delta

        imagecache.move(delta * chunksize)

        files_per_chunk = self.filesPerChunk(chunksize)

        start = Vec3.triple(-1) * files_per_chunk
        end = Vec3.triple(1) * files_per_chunk
        
        for file_pt in xyzrange( start, end ):
            file_pt[delta != 0] = 0
            
            offset = new_position + file_pt

            img = self.readImageFile(*offset)

            imagecache.write(img, offset * self.file_chunk_size)


    def generateChunks(self, chunksize):
        chunksize = Vec3(*chunksize)

        if not self.bbox.containsBbox(chunksize):
            return np.zeros(chunksize, dtype=np.uint32)

        
        imagecache = self.initializeCache(chunksize)

        last_chunk = Vec3(-1, 0, 0)
        start_bbox = Bbox( self.bbox.minpt - 1, self.bbox.minpt + chunksize + 1 )

        for chunk in descendingChunkSequence(self.totalChunks(chunksize)):
            img = imagecache.read(chunksize + 2, (-1, -1, -1))
            yield (img, start_bbox + chunksize * chunk)

            delta = chunk - last_chunk
            last_chunk = chunk

            self.__advanceCache(imagecache, files_per_chunk, chunksize, chunk, delta)


def descendingChunkSequence(total_chunks):
    """spiral inward, descend 1 z, spiral outward to start, descend 1 z, spiral inward...."""
     
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













