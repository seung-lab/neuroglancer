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
        self.buffer = np.empty(shape=shape, dtype=dtype)
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
        
        readbuffer = np.empty(shape=shape)

        bufsize = Vec3(*self.buffer.shape)

        pt = Vec3(0,0,0)
        for x,y,z in xyzrange(startpt, endpt + 1):
            pt.x, pt.y, pt.z = x, y, z

            readbuffer[ tuple(pt - startpt) ] = self.buffer[ x % bufsize.x, y % bufsize.y, z % bufsize.z ]

        return readbuffer

    def write(self, data, offset = (0,0,0)):
        databox = Bbox.from_vec(data.shape)
        bufferbox = Bbox.from_vec(self.buffer.shape)

        assert(bufferbox.containsBbox(databox), "data shape ({}) is larger than the buffer ({})".format(databox, bufferbox))

        startpt = self.offset + Vec3(*offset)
        endpt = startpt + Vec3(*data.shape)
        
        readbuffer = np.empty(shape=shape)

        bufsize = Vec3(*self.buffer.shape)

        pt = Vec3(0,0,0)
        for x,y,z in xyzrange(startpt, endpt + 1):
            pt.x, pt.y, pt.z = x, y, z
        
            self.buffer[ tuple(np.mod(pt, bufsize)) ] = data[ tuple(pt - startpt) ]

    # def write(self, data, offset = Vec3(0,0,0)):
        
    #     databox = Bbox.from_vec(data.shape)
    #     bufferbox = Bbox.from_vec(self.buffer.shape)

    #     assert(bufferbox.containsBbox(databox))

    #     self.clean = False

    #     excess = max2(Vec3(0,0,0), data.shape - (self.buffer.shape - self.offset - offset))
    #     excess = Vec3(*excess)

    #     start_points = Vec3(*(self.offset + offset))
    #     end_points = min2(start_points + data.shape, self.buffer.shape)

    #     axis_slices = tuple(map2(slice, start_points, end_points))

    #     volume_covered = Vec3(*(end_points - start_points))

    #     self.buffer[ axis_slices ] = data[ tuple(map(slice, volume_covered)) ]

    #     if excess.null():
    #         return

    #     if excess.nonzeroDims() != 1:
    #         raise Exception("The image buffer is crossing multiple dimensional barriers at once. This is forbidden. Excess: {}".format(excess))

    #     # only going to handle the one dimensional case as it becomes confusing
    #     # to think about if there are excesses in 2D or 3D at the same time. Will
    #     # handle that if necessary later.

    #     epsilon = 0.00000001

    #     circular_offset = [ 0 if excess[index] > epsilon else start_points[index] for index in xrange(3) ]

    #     excess_axis_slices = tuple(map2(slice, circular_offset, circular_offset + excess))

    #     new_start_point = [ end_points[index] if excess[index] > epsilon else start_points[index] for index in xrange(3) ]

    #     rest_of_data_slices = tuple(map2(slice, new_start_point, data.shape ))

    #     self.buffer[ excess_axis_slices ] = data[ rest_of_data_slices ]


class Volume(object):

    def __init__(self, filebboxlist, filetype):
        """filebboxlist = [ ( filename, (np.array(x,y,z), np.array(x,y,z)) ), ... ]"""
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

    def readImage(self, filename, filetype):
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

    def writeImage(self, filename, data, filetype):
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

        if not self.bbox.containsBbox(window):
            return np.empty(window.size3() + 2) # +2 to provide border for meshing

        n_chunks = (window.size3() + 2) / self.file_chunk_size
        n_chunks = np.ceil(n_chunks)

        imagecache = CircularImageCache( n_chunks * self.file_chunk_size )

        startpt = np.floor((window.minpt - 1) / self.file_chunk_size) # -1 to provide 1px border
        for x,y,z in xyzrange(n_chunks):
            grid_index = startpt + Vec3(x, y, z)

            if grid_index.x < 0 or grid_index.y < 0 or grid_index.z < 0:
                continue

            filename = self.chunk_filenames[x][y][z]

            img = self.readImage(filename)

            imagecache.write(img, self.file_chunk_size * grid_index + 1)

        return imagecache.read(window.size3() + 2, window.minpt - 1)

    def generateChunks(self, chunksize):
        chunksize = Vec3(*chunksize)

        if not self.bbox.containsBbox(chunksize):
            return np.empty(chunksize.size3() + 2) # +2 to provide border for meshing

        n_chunks = (chunksize.size3() + 2) / self.file_chunk_size
        n_chunks = np.ceil(n_chunks)

        # 27 chunks will be read into memory. 
        # @ 1024x1024x128 voxels 
        # uint32 = 13.8 GB, uint16 = 6.9 GB, uint8 = 3.5 GB
        imagecache = CircularImageCache( n_chunks * self.file_chunk_size * 3, dtype=np.uint16) 









