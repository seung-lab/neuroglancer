import re
import subprocess
from tempfile import NamedTemporaryFile
from backports.tempfile import TemporaryDirectory
import os.path
from cStringIO import StringIO
import os
import sys

import h5py
import numpy as np
from neuroglancer.pipeline import Storage, Precomputed, RegisteredTask
import string

if "POD_ID" in os.environ:
    POD_ID = os.environ["POD_ID"]
else:
    print "Warning: POD_ID environment variable not set."
    POD_ID = "POD_ID"

def h5_get(yacn_layer, name, chunk_position, default_shape = (0,2)):
    file_data = Storage(yacn_layer, n_threads=0).get_file('{}/{}.h5'.format(name, chunk_position))
    # Hate having to do this
    with NamedTemporaryFile(delete=False) as tmp:
        tmp.write(file_data)
        tmp.close()
        with h5py.File(tmp.name, 'r') as h5:
            A=h5['main']
            if A.shape is None:
                return np.zeros(default_shape,dtype=A.dtype)
            else:
                return h5['main'][:]

class RegionGraphTask(RegisteredTask):
    def __init__(self, chunk_position, crop_position, watershed_layer,
                 affinities_layer, yacn_layer, segmentation_layer):
        """
        This is the first stage of error detection a.k.a YACN.
        This task will generate a region graph for the input chunk consisting of a list
        of vertices and a list of edges.
        It will also generate a list of sample points for later use.

        All the results will be written out to the segmentation layer.
        """
        super(RegionGraphTask, self).__init__(chunk_position, crop_position, watershed_layer,
                                              affinities_layer, yacn_layer, segmentation_layer)
        self.chunk_position = chunk_position
        self.crop_position = crop_position
        self.watershed_layer = watershed_layer
        self.affinities_layer = affinities_layer
        self.segmentation_layer = segmentation_layer
        self.yacn_layer = yacn_layer

    def execute(self):
        self._parse_chunk_position()
        self._parse_crop_position()
        with TemporaryDirectory() as in_dir:
            with TemporaryDirectory() as out_dir:
                self.in_dir = in_dir
                self.out_dir = out_dir
                self._create_temporary_hdf5(storage=Storage(self.watershed_layer), 
                        slices=self._chunk_slices, 
                        name="raw.h5")
                self._create_temporary_hdf5(storage=Storage(self.affinities_layer), 
                        slices=self._chunk_slices, 
                        name="aff.h5")
                self._create_temporary_hdf5(storage=Storage(self.segmentation_layer), 
                        slices=self._chunk_slices, 
                        name="mean_agg_tr.h5")

                self._run_julia()
        
        #Is necessary to release references to in_dir and out_dir?
        self.in_dir=None
        self.out_dir=None

    def _parse_chunk_position(self):
        match = re.match(r'^(\d+)-(\d+)_(\d+)-(\d+)_(\d+)-(\d+)$', self.chunk_position)
        (self._xmin, self._xmax,
         self._ymin, self._ymax,
         self._zmin, self._zmax) = map(int, match.groups())
        self._chunk_slices = (slice(self._xmin, self._xmax),
                              slice(self._ymin, self._ymax),
                              slice(self._zmin, self._zmax))

    def _parse_crop_position(self):
        match = re.match(r'^(\d+)-(\d+)_(\d+)-(\d+)_(\d+)-(\d+)$', self.crop_position)
        (self._crop_xmin, self._crop_xmax,
         self._crop_ymin, self._crop_ymax,
         self._crop_zmin, self._crop_zmax) = map(int, match.groups())
        self._crop_slices = (slice(self._crop_xmin, self._crop_xmax),
                             slice(self._crop_ymin, self._crop_ymax),
                             slice(self._crop_zmin, self._crop_zmax))


    def _run_julia(self):
        current_dir = os.path.dirname(os.path.abspath(__file__))
        ret = subprocess.call(["julia",
                  current_dir+"/../../ext/third_party/yacn/pre/full_prep_script.jl",
                  self.in_dir,
                  self.out_dir])
        assert ret == 0
        self._save_results()

    def _save_results(self):
        s = Storage(self.yacn_layer)
        for fname, fextension in map(os.path.splitext,os.listdir(self.out_dir)):
            print fname
            with open(os.path.join(self.out_dir,fname + fextension),'rb') as f:
                s.put_file(file_path=(fname + '/{}'+fextension).format(self.chunk_position),
                           content=f.read()) 
                f.close()
        s.wait()

    def _create_temporary_hdf5(self, storage, slices, name):
        #tmp_file = NamedTemporaryFile(delete=True, suffix='.h5')
        with h5py.File(os.path.join(self.in_dir, name),'w') as h5:
            data = Precomputed(storage)[slices]
            if data.shape[3] == 1:
                data = np.squeeze(data,3)
            h5.create_dataset('main', data=data.T)
            h5.close()

class DiscriminateTask(RegisteredTask):
    def __init__(self, chunk_position, crop_position,
                 image_layer, segmentation_layer, yacn_layer, errors_layer):
        """
        This is the second stage of error detection a.k.a YACN.

        It will do inference on image from the microscope, at the location
        given by the sample files, and masking out all the ids of the
        segmentation which doesn't contain the sample point.\

        chunk_position is in absolute coordinates from the layer origin.
        crop_position in in relative coordinates to the chunk_position
        """
        super(DiscriminateTask, self).__init__(chunk_position, crop_position,
                 image_layer, segmentation_layer, yacn_layer, errors_layer)

        self.chunk_position = chunk_position
        self.crop_position = crop_position
        self.image_layer = image_layer
        self.segmentation_layer = segmentation_layer
        self.yacn_layer = yacn_layer
        self.errors_layer = errors_layer

    def yacn_get(self, name):
        return h5_get(self.yacn_layer, name, self.chunk_position)

    def execute(self):
        self._parse_chunk_position()
        self._parse_crop_position()
        image = self._get_image_chunk()
        segmentation = self.yacn_get("thickened_mean_agg_tr")
        samples = self.yacn_get("samples")
        self._get_weights()
        self._infer(image, segmentation, samples)
  
    def _parse_chunk_position(self):
        match = re.match(r'^(\d+)-(\d+)_(\d+)-(\d+)_(\d+)-(\d+)$', self.chunk_position)
        (self._xmin, self._xmax,
         self._ymin, self._ymax,
         self._zmin, self._zmax) = map(int, match.groups())
        self._chunk_slices = (slice(self._xmin, self._xmax),
                              slice(self._ymin, self._ymax),
                              slice(self._zmin, self._zmax))

    def _parse_crop_position(self):
        match = re.match(r'^(\d+)-(\d+)_(\d+)-(\d+)_(\d+)-(\d+)$', self.crop_position)
        (self._crop_xmin, self._crop_xmax,
         self._crop_ymin, self._crop_ymax,
         self._crop_zmin, self._crop_zmax) = map(int, match.groups())
        self._crop_slices = (slice(self._crop_xmin, self._crop_xmax),
                             slice(self._crop_ymin, self._crop_ymax),
                             slice(self._crop_zmin, self._crop_zmax))

    def _get_image_chunk(self):
        image = Precomputed(Storage(self.image_layer))[self._chunk_slices] 
        return np.squeeze(image, axis=3).T

    def _get_segmentation_chunk(self):
        self._seg_storage = Storage(self.segmentation_layer)
        seg = Precomputed(self._seg_storage)[self._chunk_slices] 
        return np.squeeze(seg, axis=3).T

    def _infer(self, image, segmentation, samples):
        #os.environ["CUDA_VISIBLE_DEVICES"]="0"
        from ext.third_party.yacn.nets.discriminate3_online_inference import main_model
        main_model.restore('/tmp/{}/nets/discriminate3/latest.ckpt'.format(POD_ID))
        print image.shape, segmentation.shape
        output = main_model.inference(image, segmentation, samples)
        self._write_chunk(output)

    def _write_chunk(self, output):
        output = output[:,:,:,:,0] #squeeze 1-d axes
        Precomputed(Storage(self.errors_layer))[
        self._xmin + self._crop_xmin: self._xmin + self._crop_xmax,
        self._ymin + self._crop_ymin: self._ymin + self._crop_ymax,
        self._zmin + self._crop_zmin: self._zmin + self._crop_zmax] = output.T[self._crop_slices]

    def _get_weights(self):
        try:
            os.makedirs('/tmp/{}/nets/discriminate3/'.format(POD_ID))
        except OSError:
            pass #folder already exists
        s = Storage(self.yacn_layer)
        for file_path in ['nets/discriminate3/latest.ckpt',
                          'nets/discriminate3/latest.ckpt.index',
                          'nets/discriminate3/latest.ckpt.data-00000-of-00001']:

            with open('/tmp/{}/'.format(POD_ID) + file_path, 'wb') as f:
                f.write(s.get_file(file_path))


class FloodFillingTask(RegisteredTask):
    def __init__(self, chunk_position, neighbours_chunk_position, crop_position,
                 image_layer, watershed_layer, yacn_layer,
                 errors_layer, skip_threshold):
        """
        This is the third stage of error detection a.k.a YACN.

        Using a flood filling network, it will try to fix the errors
        detected in stage 2.

        chunk_position is in absolute coordinates from the layer origin.
        crop_position in in relative coordinates to the chunk_position
        """
        super(FloodFillingTask, self).__init__(chunk_position, neighbours_chunk_position, crop_position,
                 image_layer, watershed_layer, yacn_layer, errors_layer, skip_threshold)

        self.chunk_position = chunk_position
        self.crop_position = crop_position
        self.neighbours_chunk_position = string.split(string.strip(neighbours_chunk_position)," ")
        self.image_layer = image_layer
        self.watershed_layer = watershed_layer
        self.errors_layer = errors_layer
        self.yacn_layer = yacn_layer
        self.skip_threshold = skip_threshold


    def yacn_get(self, name):
        return h5_get(self.yacn_layer, name, self.chunk_position)

    def execute(self):
        self._parse_chunk_position()
        self._parse_crop_position()
        self.yacn_storage = Storage(self.yacn_layer, n_threads=0)
        image = self._get_image_chunk()

        errors = self._get_errors_chunk()
        watershed = self.yacn_get("thickened_raw")
        samples = self.yacn_get("samples")
        height_map = self.yacn_get("height_map")

        neighbours_vertices = [h5_get(self.yacn_layer, "vertices", chunk) for chunk in self.neighbours_chunk_position]
        neighbours_edges = [self._get_edges_for_chunk(chunk) for chunk in self.neighbours_chunk_position]
        neighbours_contact_edges = [h5_get(self.yacn_layer, "full_edges", chunk) for chunk in self.neighbours_chunk_position]

        combined_vertices = np.concatenate(neighbours_vertices,axis=0)
        combined_edges = np.concatenate(neighbours_edges,axis=0)
        combined_contact_edges = np.concatenate(neighbours_contact_edges,axis=0)

        #os.environ["CUDA_VISIBLE_DEVICES"]="0"

        sys.path.insert(0, os.path.realpath('../../ext/third_party'))
        import ext.third_party.yacn.reconstruct.reconstruct as reconstruct
        from ext.third_party.yacn.reconstruct.commit_changes import *

        if np.count_nonzero(image) < self.skip_threshold * image.size:
            revised_combined_edges = combined_edges
        else:
            revised_combined_edges = reconstruct.reconstruct_wrapper(image=image, 
                    watershed=watershed, 
                    samples=samples, 
                    vertices=combined_vertices, 
                    edges=combined_edges, 
                    errors=errors,
                    full_edges=combined_contact_edges, 
                    height_map = height_map)

        E = unpack_edges(revised_combined_edges)
        revised_edges = [pack_edges(restrict(E, unpack_edges(f))) for f in neighbours_contact_edges]
        s = self.yacn_storage

        for edges, chunk_position in zip(revised_edges, self.neighbours_chunk_position):
            with NamedTemporaryFile(delete=False) as tmp:
                with h5py.File(tmp.name, 'w') as h5:
                    h5['main'] = edges
                with open(tmp.name) as f:
                    s.put_file(file_path='revised_edges/{}.h5'.format(chunk_position),
                               content=f.read())
        s.wait()
  
    def _parse_chunk_position(self):
        match = re.match(r'^(\d+)-(\d+)_(\d+)-(\d+)_(\d+)-(\d+)$', self.chunk_position)
        (self._xmin, self._xmax,
         self._ymin, self._ymax,
         self._zmin, self._zmax) = map(int, match.groups())
        self._chunk_slices = (slice(self._xmin, self._xmax),
                              slice(self._ymin, self._ymax),
                              slice(self._zmin, self._zmax))

    def _parse_crop_position(self):
        match = re.match(r'^(\d+)-(\d+)_(\d+)-(\d+)_(\d+)-(\d+)$', self.crop_position)
        (self._crop_xmin, self._crop_xmax,
         self._crop_ymin, self._crop_ymax,
         self._crop_zmin, self._crop_zmax) = map(int, match.groups())
        self._crop_slices = (slice(self._crop_xmin, self._crop_xmax),
                             slice(self._crop_ymin, self._crop_ymax),
                             slice(self._crop_zmin, self._crop_zmax))
    
    def _get_image_chunk(self):
        image = Precomputed(Storage(self.image_layer,n_threads=0))[self._chunk_slices] 
        return np.squeeze(image, axis=3).T

    def _get_watershed_chunk(self):
        self._watershed_storage = Storage(self.watershed_layer,n_threads=0)
        seg = Precomputed(self._watershed_storage)[self._chunk_slices] 
        return np.squeeze(seg, axis=3).T

    def _get_errors_chunk(self):
        self._error_storage = Storage(self.errors_layer,n_threads=0)
        seg = Precomputed(self._error_storage,pad=0)[self._chunk_slices] 
        return np.squeeze(seg, axis=3).T

    def _get_edges_for_chunk(self, chunk_position):
        file_data = self.yacn_storage.get_file('revised_edges/{}.h5'.format(chunk_position))
        if file_data is None:
            file_data = self.yacn_storage.get_file('mean_edges/{}.h5'.format(chunk_position))
        assert file_data is not None

        default_shape = (0,2)
        # Hate having to do this
        with NamedTemporaryFile(delete=False) as tmp:
            tmp.write(file_data)
            tmp.close()
            with h5py.File(tmp.name, 'r') as h5:
                A=h5['main']
                if A.shape is None:
                    return np.zeros(default_shape,dtype=A.dtype)
                else:
                    return h5['main'][:]
    def _get_weights(self):
        tmp_dir = "/tmp/{}/".format(POD_ID)
        try:
            os.makedirs(os.path.join(tmp_dir,'nets/discriminate3/'))
        except OSError:
            pass #folder already exists
        try:
            os.makedirs(os.path.join(tmp_dir,'nets/sparse_vector_labels/'))
        except OSError:
            pass #folder already exists
        s = Storage(self.yacn_layer)
        for file_path in ['nets/discriminate3/latest.ckpt',
                          'nets/discriminate3/latest.ckpt.index',
                          'nets/discriminate3/latest.ckpt.data-00000-of-00001',
                          'nets/sparse_vector_labels/latest.ckpt',
                          'nets/sparse_vector_labels/latest.ckpt.index',
                          'nets/sparse_vector_labels/latest.ckpt.data-00000-of-00001']:

            with open(os.path.join(tmp_dir, file_path), 'wb') as f:
                f.write(s.get_file(file_path))



class RelabelTask(RegisteredTask):

    def __init__(self, layer_in_path, layer_out_path, chunk_position, mapping_path):
        """Summary
        
        Args:
            layer_in_path (str): Contains the chunks to be relabel
            layer_out_path (str): Where to place the relabel chunks
            mapping_path (str) Path relative to layer_out_path containing 
            a .npy file with the remmaping rules.
        """
        super(RelabelTask, self).__init__(layer_in_path, layer_out_path, chunk_position, mapping_path)
        self.layer_in_path = layer_in_path
        self.mapping_path = mapping_path
        self.chunk_position = chunk_position
        self.layer_out_path = layer_out_path

    def execute(self):
        self._parse_chunk_position()
        self._get_input_chunk()
        self._get_mapping()
        self._relabel_chunk()
        self._upload_chunk()

    def _parse_chunk_position(self):
        match = re.match(r'^(\d+)-(\d+)_(\d+)-(\d+)_(\d+)-(\d+)$', self.chunk_position)
        (self._xmin, self._xmax,
         self._ymin, self._ymax,
         self._zmin, self._zmax) = map(int, match.groups())
        self._chunk_slices = (slice(self._xmin, self._xmax),
                              slice(self._ymin, self._ymax),
                              slice(self._zmin, self._zmax))

    def _get_input_chunk(self):
        self._data = Precomputed(Storage(self.layer_in_path,n_threads=0))[self._chunk_slices] 

    def _get_mapping(self):
        if not os.path.exists('/tmp/mapping.npy'):
            content = Storage(self.layer_out_path,n_threads=0).get_file(self.mapping_path)
            with open('/tmp/mapping.npy', 'wb') as f:
                f.write(content)
        self._mapping = np.load('/tmp/mapping.npy')

    def _relabel_chunk(self):
        self._data = self._mapping[self._data]

    def _upload_chunk(self):
        pr = Precomputed(Storage(self.layer_out_path,n_threads=0))
        pr[self._chunk_slices] = self._data
