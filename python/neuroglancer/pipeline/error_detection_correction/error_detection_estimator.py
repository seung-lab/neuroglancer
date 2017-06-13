#copy of discrim_net3.py
from convkernels3d import *
from activations import *
from utils import *
from . import Estimator
from yacn.kernels.graph_naming import tfclass

initial_activations = [
    lambda x: x,
    tf.nn.elu,
    tf.nn.elu,
    tf.nn.elu,
    tf.nn.elu,
    tf.nn.elu,
    tf.nn.elu
    ]

activations = [
    lambda x: x,
    tf.nn.elu,
    tf.nn.elu,
    tf.nn.elu,
    tf.nn.elu,
    tf.nn.elu,
    tf.nn.elu
    ]

connection_schemas = [
    Connection2dSchema(size=(4,4),strides=(2,2)),
    Connection2dSchema(size=(4,4),strides=(2,2)),
    Connection3dFactorizedSchema(size=(4,4,4),strides=(1,2,2)),
    Connection3dFactorizedSchema(size=(4,4,4),strides=(2,2,2)),
    Connection3dFactorizedSchema(size=(4,4,4),strides=(2,2,2)),
    Connection3dFactorizedSchema(size=(4,4,4),strides=(2,2,2))
    ]

range_expanders = [range_tuple_expander(strides=strides3d(x), size=size3d(x)) for x in connection_schemas]
def patch_size_suggestions(top_shape):
    base_patch_size = shape_to_slices(top_shape)
    patch_size_suggestions = list(reversed(
        map(slices_to_shape, cum_compose(*reversed(range_expanders))(base_patch_size))))
    print(patch_size_suggestions)
    return patch_size_suggestions

@tfclass
class ErrorDetectionEstimator(Estimator):
    """
    Create two networks which shares all their weights
    The first one (and smaller) to predict errors and
    the second one and larger for segment completion.

    This two differents tasks are simulatenusly learned
    with the same weights.
    """

    def __init__(self, patch_size, n_in, n_out):
        self._patch_size = patch_size
        self._n_in = n_in
        self._n_out = n_out

        feature_schemas = [
            FeatureSchema(nfeatures=n_in+n_out,level=0),
            FeatureSchema(nfeatures=4, level=1),
            FeatureSchema(nfeatures=24,level=2),
            FeatureSchema(nfeatures=28,level=3),
            FeatureSchema(nfeatures=32,level=4),
            FeatureSchema(nfeatures=48,level=5),
            FeatureSchema(nfeatures=64,level=6)]


        self._initial = MultiscaleUpConv3d(
            feature_schemas=feature_schemas,
            connection_schemas=connection_schemas,
            activations=initial_activations)
        self._it1 = MultiscaleConv3d(
            feature_schemas, feature_schemas, connection_schemas,
            connection_schemas, activations)
        self._it2 = MultiscaleConv3d(
            feature_schemas, feature_schemas, connection_schemas,
            connection_schemas, activations)
        self._it3 = MultiscaleConv3d(
            feature_schemas, feature_schemas,
            connection_schemas, connection_schemas, activations)
        self._it4 = MultiscaleConv3d(
            feature_schemas, feature_schemas,
            connection_schemas, connection_schemas, activations)
        self._it5 = MultiscaleConv3d(
            feature_schemas, feature_schemas, connection_schemas, connection_schemas, activations)

        ds_it1_pre = MultiscaleConv3d(
            feature_schemas[2:], feature_schemas[2:],
            connection_schemas[2:], connection_schemas[2:], activations[2:])
        ds_it2_pre = MultiscaleConv3d(
            feature_schemas[2:], feature_schemas[2:],
            connection_schemas[2:], connection_schemas[2:], activations[2:])
        
        self._ds_it1 = lambda l: l[0:2] + ds_it1_pre(l[2:])
        self._ds_it2 = lambda l: l[0:2] + ds_it2_pre(l[2:])

        linears = [FullLinear(n_in=x.nfeatures, n_out=1) for x in feature_schemas]
        self._apply_linears = lambda tower: [f(x) for f,x in zip(linears, tower)]

    def error_prediction(self, x):
        padded_x = tf.concat([x,tf.zeros((1,) + self._patch_size + (self._n_out,))],4)
        return compose(
                self._initial,
                self._it1,
                self._it2,
                self._ds_it1,
                self._ds_it2,
                self._apply_linears
                )(padded_x)

    def segment_completion(self, _input):
        """
        The input is a single occluded object concatenated to 
        electron microscopy image.
        """
        padded_input = tf.concat([_input, 
            tf.zeros((1,) + self._patch_size + (self._n_out,))],4)
        return compose(
                self._initial,
                self._it1,
                self._it2,

                self._ds_it1,
                self._ds_it2,
                self._ds_it1,
                self._ds_it2,

                self._it3,
                self._it4,
                self._it5)(padded_input)[0][:,:,:,:, self._n_in: self._n_in+self._n_out] #what is this indexing?