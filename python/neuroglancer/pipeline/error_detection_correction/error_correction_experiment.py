from __future__ import absolute_import
from __future__ import print_function
from __future__ import division

import logging

import tensorflow as tf

from ext.third_party.yacn.nets.utils import static_shape, rand_bool
from ext.third_party.yacn.nets import basic_net2
from . import Experiment
from .graph_naming import tfclass
from .augment import default_augmentation
from .summaries import image_summary, EMA

def extract_central(X):
    """
    Returns the central pixel
    """
    patch_size = static_shape(X)[1:4]
    return X[:,patch_size[0]//2:patch_size[0]//2+1,
               patch_size[1]//2:patch_size[1]//2+1,
               patch_size[2]//2:patch_size[2]//2+1,:]

def affinity(x, y):
    displacement = x - y
    interaction = tf.reduce_sum(
        displacement * displacement,
        reduction_indices=[4],
        keep_dims=True)
    return tf.exp(-0.5 * interaction)


def bounded_cross_entropy(guess,truth):
    guess = 0.999998*guess + 0.000001
    return  - truth * tf.log(guess) - (1-truth) * tf.log(1-guess)

def label_diff(x,y):
    return tf.to_float(tf.equal(x,y))


@tfclass
class ErrorCorrectionExperiment(Experiment):

    def __init__(self, dataset, nvec_labels, maxn, offsets):
        
        self._dataset = dataset
        self._nvec_labels = nvec_labels
        self._maxn = maxn
        self._offsets = offsets

        self.summaries = []

    def build_graph(self, sess, devices, is_train_iter, step):
        self._sess = sess
        self._devices = devices
        self._is_train_iter = is_train_iter
        self._step = step

        # TODO make it easy to swap estimators
        self._estimator = basic_net2.make_forward_net(
            self._dataset.patch_size, 2, self._nvec_labels)

        self._data_parallelism()
        self._create_optimizer()
        self._read_dataset()

    def _data_parallelism(self):
        """
        Data parallelism
        Every gpu trains on different data and the gradients 
        are combined
        """
        correction_loss = 0.0
        for i,d in enumerate(self._devices):
                tower_loss = self._create_tower(d)
                correction_loss += tower_loss

        self._loss = correction_loss / len(self._devices)


    def _create_glimpse(self):
        """
        This takes a random crop from a random volume.
        This random crop that we refer as a glimpse is randomly
        modified and return.

        More specifically two glimpses are return:
        `image_glimpse`: eletron microscopy image.
        `human_labels_glimpse`:random cropped data augment uint32 segmentation 
            produced by manual annotation.
        """
        vol_id = self._dataset.get_random_volume_id(self._is_train_iter)
        focus = self._get_random_focus(vol_id)
        
        aug_image, aug_label = default_augmentation()
        image_glimpse = aug_image(self._dataset['image'][vol_id,focus])

        human_labels = self._dataset['human_labels'][vol_id,focus]
        human_labels_glimpse = aug_label(human_labels)

        self.summaries.append(image_summary("image", image_glimpse))
        self.summaries.append(image_summary("human_labels_glimpse", tf.to_float(human_labels_glimpse)))

        return (vol_id, image_glimpse, human_labels_glimpse)


    def _create_tower(self, d):
        """Data parallelism
        
        Args:
            d (str): device identifier
        """
        with tf.device(d):
            (vold_id, image_glimpse,
             human_labels_glimpse) = self._create_glimpse()

            # TODO check if this point corresponds to a point marked as valid
            central_label = tf.reshape(extract_central(human_labels_glimpse), [])
            vol_valid = self._dataset['valid']

            is_valid = tf.to_float(vol_valid[vold_id, central_label])
            max_label = tf.shape(self._dataset['valid'].get_volume(vold_id))[0]

            # Choose ids to set as mask
            #0 means that this label is removed
            #ensure that the central object is not masked, and also ensure that only valid objects are masked.
            central_label_set = tf.scatter_nd(tf.reshape(central_label,[1,1]), [1], [max_label])
            error_probability = tf.random_uniform([],minval=0.0,maxval=0.75,dtype=tf.float32)
            masked_label_set = tf.maximum(tf.to_int32(rand_bool([max_label],error_probability)), central_label_set)

            #create actual mask
            masked_label_set = tf.concat([tf.zeros([1],dtype=tf.int32),masked_label_set[1:]],0)
            mask_glimpse = tf.to_float(tf.gather(masked_label_set, human_labels_glimpse))
            central = tf.to_float(tf.gather(central_label_set, human_labels_glimpse))

            vector_labels = self._estimator(tf.concat([image_glimpse, mask_glimpse],4))
            central_vector = tf.reduce_sum(
                central * vector_labels,
                reduction_indices = [1,2,3], keep_dims=True) / tf.reduce_sum(central, keep_dims=False)

            guess = affinity(central_vector, vector_labels)
            truth = label_diff(human_labels_glimpse, central_label)
            loss = tf.reshape(tf.reduce_sum(bounded_cross_entropy(guess,truth)) * is_valid, [])
            return loss

    def _train_op(self):
        ema_loss = EMA(decay=0.99)
        ema_loss.update(self._loss)

        with tf.control_dependencies([self._step.assign_add(1)]):
            optimizer = tf.train.AdamOptimizer(0.0001, beta1=0.95, beta2=0.9995, epsilon=0.1)
            op = optimizer.minimize(self._loss, 
                colocate_gradients_with_ops=True,
                var_list=tf.get_collection(tf.GraphKeys.TRAINABLE_VARIABLES))

            quick_summary_op = tf.summary.merge([
                tf.summary.scalar("loss", self._loss),
                tf.summary.scalar("ema_loss", ema_loss.val)])

            return op, quick_summary_op

    def _test_op(self):
        """
        Test op doesn't advance the step
        """
        ema_test_loss = EMA(decay=0.9)
        ema_test_loss.update(self._loss)

        quick_summary_op = tf.summary.merge([
            tf.summary.scalar("test_loss", self._loss),
            tf.summary.scalar("ema_test_loss", ema_test_loss.val)])
        return tf.no_op(), quick_summary_op
