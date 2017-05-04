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
        s.wait_until_queue_empty()

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

    def execute(self):
        self._parse_chunk_position()
        self._parse_crop_position()
        image = self._get_image_chunk()
        segmentation = self._get_segmentation_chunk()
        samples = self._get_samples_chunk()
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

    def _get_samples_chunk(self):
        file_data = Storage(self.yacn_layer).get_file('samples/{}.h5'.format(self.chunk_position))
        # Hate having to do this
        with NamedTemporaryFile(delete=False) as tmp:
            tmp.write(file_data)
            tmp.close()
            with h5py.File(tmp.name, 'r') as h5:
                return h5['main'][:]
    

    def _infer(self, image, segmentation, samples):
        #os.environ["CUDA_VISIBLE_DEVICES"]="0"
        from ext.third_party.yacn.nets.discriminate3_inference import main_model
        main_model.restore('/tmp/net/discriminate/latest.ckpt')
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
            os.makedirs('/tmp/net/discriminate/')
            s = Storage(self.yacn_layer)
            for file_path in ['net/discriminate/latest.ckpt',
                              'net/discriminate/latest.ckpt.index',
                              'net/discriminate/latest.ckpt.data-00000-of-00001']:

                with open('/tmp/' + file_path, 'wb') as f:
                    f.write(s.get_file(file_path))

        except OSError:
            pass #folder already exists

class FloodFillingTask(RegisteredTask):
    def __init__(self, chunk_position, neighbours_chunk_position, crop_position,
                 image_layer, watershed_layer, yacn_layer,
                 errors_layer, affinities_layer):
        """
        This is the third stage of error detection a.k.a YACN.

        Using a flood filling network, it will try to fix the errors
        detected in stage 2.

        chunk_position is in absolute coordinates from the layer origin.
        crop_position in in relative coordinates to the chunk_position
        """
        super(FloodFillingTask, self).__init__(chunk_position, neighbours_chunk_position, crop_position,
                 image_layer, watershed_layer, yacn_layer,
                 errors_layer, affinities_layer)

        self.chunk_position = chunk_position
        self.crop_position = crop_position
        self.neighbours_chunk_position = string.split(string.strip(neighbours_chunk_position)," ")
        self.image_layer = image_layer
        self.watershed_layer = watershed_layer
        self.affinities_layer = affinities_layer
        self.errors_layer = errors_layer
        self.yacn_layer = yacn_layer

    def execute(self):
        self._parse_chunk_position()
        self._parse_crop_position()
        self.yacn_storage = Storage(self.yacn_layer, n_threads=0)
        errors = self._get_errors_chunk()
        image = self._get_image_chunk()
        watershed = self._get_watershed_chunk()
        samples = self._get_sample_for_chunk()
        affinities = self._get_affinities_chunk()

        neighbours_vertices = [self._get_vertices_for_chunk(chunk) for chunk in self.neighbours_chunk_position]
        neighbours_edges = [self._get_edges_for_chunk(chunk) for chunk in self.neighbours_chunk_position]
        neighbours_contact_edges = [self._get_contact_edges_for_chunk(chunk) for chunk in self.neighbours_chunk_position]

        combined_vertices = np.concatenate(neighbours_vertices,axis=0)
        combined_edges = np.concatenate(neighbours_edges,axis=0)
        combined_contact_edges = np.concatenate(neighbours_contact_edges,axis=0)

        #os.environ["CUDA_VISIBLE_DEVICES"]="0"

        sys.path.insert(0, os.path.realpath('../../ext/third_party'))
        import ext.third_party.yacn.reconstruct.reconstruct as reconstruct
        from ext.third_party.yacn.reconstruct.commit_changes import *

        revised_combined_edges = reconstruct.reconstruct_wrapper(image=image, 
                watershed=watershed, 
                samples=samples, 
                vertices=combined_vertices, 
                edges=combined_edges, 
                errors=errors,
                full_edges=combined_contact_edges, 
                affinities = affinities)

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
        s.wait_until_queue_empty()
  
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
        seg = Precomputed(self._error_storage)[self._chunk_slices] 
        return np.squeeze(seg, axis=3).T

    def _get_affinities_chunk(self):
        self._affinities_storage = Storage(self.affinities_layer,n_threads=0)
        seg = Precomputed(self._affinities_storage)[self._chunk_slices] 
        return seg.T

    def _get_sample_for_chunk(self):
        file_data = self.yacn_storage.get_file('samples/{}.h5'.format(self.chunk_position))
        # Hate having to do this
        with NamedTemporaryFile(delete=False) as tmp:
            tmp.write(file_data)
            tmp.close()
            with h5py.File(tmp.name, 'r') as h5:
                return h5['main'][:]

    def _get_vertices_for_chunk(self, chunk_position):
        file_data = self.yacn_storage.get_file('vertices/{}.h5'.format(chunk_position))
        # Hate having to do this
        with NamedTemporaryFile(delete=False) as tmp:
            tmp.write(file_data)
            tmp.close()
            with h5py.File(tmp.name, 'r') as h5:
                return h5['main'][:]

    def _get_contact_edges_for_chunk(self, chunk_position):
        file_data = self.yacn_storage.get_file('contact_edges/{}.h5'.format(chunk_position))
        # Hate having to do this
        with NamedTemporaryFile(delete=False) as tmp:
            tmp.write(file_data)
            tmp.close()
            with h5py.File(tmp.name, 'r') as h5:
                return h5['main'][:]

    def _get_edges_for_chunk(self, chunk_position):
        file_data = self.yacn_storage.get_file('revised_edges/{}.h5'.format(chunk_position))
        if file_data is None:
            file_data = self.yacn_storage.get_file('mean_edges/{}.h5'.format(chunk_position))
        assert file_data is not None

        # Hate having to do this
        with NamedTemporaryFile(delete=False) as tmp:
            tmp.write(file_data)
            tmp.close()
            with h5py.File(tmp.name, 'r') as h5:
                return h5['main'][:]

    def _get_weights(self):
        s = (self.yacn_layer)
        for file_path in ['net/discriminate/latest.ckpt',
                          'net/discriminate/latest.ckpt.index',
                          'net/discriminate/latest.ckpt.data-00000-of-00001',
                          'net/sparse_vectors/latest.ckpt',
                          'net/sparse_vectors/latest.ckpt.index',
                          'net/sparse_vectors/latest.ckpt.data-00000-of-00001']:

            with open(file_path, wb) as f:
                f.write(s.get_file(file_path))

