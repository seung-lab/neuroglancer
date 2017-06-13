#copy of discrimante3.py

import tensorflow as tf
import logging

from ext.third_party.yacn import kernels
from ext.third_party.yacn.kernels.graph_naming import tfclass


from utils import (random_occlusion, equal_to_centre, image_summary, static_shape, compose,
    slices_to_shape, shape_to_slices, EMA)
from localization import localized_errors, error_free_window_conv
from loss_functions import  upsample_mean
import augment
from error_detection_estimator import (ErrorDetectionEstimator, patch_size_suggestions,
    range_expanders)
from ext.third_party.yacn.nets import Experiment

@tfclass
class ErrorDetectionExperiment(Experiment):
    def __init__(self, patch_size, dataset, devices):
        """
        Error detection is composed of a large network which goal is to reconstruct an object
        which has being partially ocluded. (segment_completion loss)
        The deep supervision loss which is to tell if there is an error in the object is what
        we actually care about.
        
        Args:
            patch_size (tuple(int)): field of view of the network
            dataset (Dataset): Object containing all the data
            devices (str): Where to train on
        """
        self._patch_size = patch_size
        self.padded_patch_size = (1,) + patch_size + (1,)
        self._dataset = dataset
        self._devices = devices

        self.summaries = []

        self._create_session()
        self._create_forward_network()
        self._data_parallelism()
        self._create_optimizer()
        self._read_dataset()

    def _create_forward_network(self):
        self._estimator = ErrorDetectionEstimator(self._patch_size, 2, 1)

    def _data_parallelism(self):
        """
        Data parallelism
        Every gpu trains on different data and the gradients 
        are combined
        """
        detection_loss = tf.Variable(0.0 , trainable=False)
        segment_completion_loss = tf.Variable(0.0 , trainable=False) 
        for i,d in enumerate(self._devices):
                tower_loss, tower_segment_completion_loss = self._create_tower(d)
                detection_loss += tower_loss
                segment_completion_loss += tower_segment_completion_loss

        self._loss = detection_loss/len(self._devices)
        self._segment_completion_loss = segment_completion_loss/len(self._devices)

    def _create_tower(self, d):
        """Data parallelism
        
        Args:
            d (str): device identifier
        """
        with tf.device(d):
            (single_object_human_labels_glimpse, single_object_machine_labels_glimpse,
             occluded_glimpse, image_glimpse,
             human_labels_glimpse) = self._create_glimpse()

            any_error = self._is_there_any_error_in_the_glimpse(
                single_object_human_labels_glimpse, 
                single_object_machine_labels_glimpse)

            segment_completion_loss = self._create_segment_completion_task(image_glimpse, 
                occluded_glimpse, single_object_human_labels_glimpse)

            (error_prediction_loss, machine_labels_error_prediction,
            human_labels_error_prediction) = self._create_error_detection_task(image_glimpse, 
                single_object_machine_labels_glimpse, single_object_human_labels_glimpse,
                any_error)

            error_prediction_loss += self._create_error_localization_task(machine_labels_error_prediction,
                single_object_machine_labels_glimpse, human_labels_glimpse, any_error, 
                human_labels_error_prediction)
        
        return error_prediction_loss, segment_completion_loss

    def _create_glimpse(self):
        """
        This takes a random crop from a random volume.
        This random crop that we refer as a glimpse is randomly
        modified and return.

        More specifically five glimpses are return:
        `image_glimpse`: eletron microscopy image.
        `single_object_machine_labels_glimpse`: randomly cropped data augmented boolean
           mask that contains 1s in the segment contained by the center of the volume 
           and 0s everywhere else. This was created by running mean affinity 
           agglomeration on top of watershed.
        `human_labels_glimpse`:random cropped data augment uint32 segmentation 
            produced by manual annotation.
        `single_object_human_labels_glimpse`: same as human_labels_glimpse but 
            transformed into a binary mask which contains 1s for the segment in the 
            center of the glimpse and 0s everywhere else.
        `occluded_glimpse`: It randomly blacks out halfs of the 
            single_object_human_labels_glimpse. This is used to train an Estimator to 
            go complete the blacked out part.
        """
        vol_id = self._dataset.get_random_volume_id(self.is_train_iter)
        focus = self._get_random_focus(vol_id)
        rr = augment.RandomRotationPadded()

        image_glimpse = rr(self._dataset['image'][vol_id,focus])
        single_object_machine_labels_glimpse = rr(equal_to_centre(self._dataset['machine_labels'][vol_id, focus]))

        human_labels = self._dataset['human_labels'][vol_id,focus]
        single_object_human_labels_glimpse = rr(equal_to_centre(human_labels))
        human_labels_glimpse = rr(human_labels)

        occluded_glimpse = random_occlusion(single_object_human_labels_glimpse)
        
        self.summaries.append(image_summary("single_object_machine_labels_glimpse", single_object_machine_labels_glimpse))
        self.summaries.append(image_summary("single_object_human_labels_glimpse", single_object_human_labels_glimpse))
        self.summaries.append(image_summary("human_labels_glimpse", tf.to_float(human_labels_glimpse)))
        self.summaries.append(image_summary("occluded", occluded_glimpse))

        return (single_object_human_labels_glimpse, single_object_machine_labels_glimpse, 
                occluded_glimpse, image_glimpse, human_labels_glimpse)

    def _is_there_any_error_in_the_glimpse(self, object_0, object_1):
        # the single_object_human_labels_glimpse were produced by merging
        # and splitting supervoxels.
        # the single_object_machine_labels_glimpse were produced by 
        # applying mean affinity agglomeration to the same supervoxels
        # So any_error is a tf.bool which equals True when the single
        # object of the human_labels is composed by a different set 
        # of supervoxels than the human labels.
        any_error = tf.logical_not(kernels.reduce_all(
            tf.equal(object_0, object_1)), name="any_error")

        # don't propagate any gradients to the data provider
        # our dataset is stored as a tensorflow variable
        # so we wan't to make sure we don't modified it
        # in theory dataset indexing already stops the gradient but 
        # we can add this to be more sure (we are lazy to double check
        # it is actually working)
        any_error = tf.stop_gradient(any_error)
        return any_error

    def _create_segment_completion_task(self, image_glimpse , occluded_glimpse,
        single_object_human_labels_glimpse):
        """
        Notice how the input to both task is first a binary mask 
        and secondly an EM image
        """
        
        segment_completion = self._estimator.segment_completion(tf.concat(
            [occluded_glimpse, image_glimpse],4))
        segment_completion_loss = tf.reduce_sum(tf.nn.sigmoid_cross_entropy_with_logits(
            logits=segment_completion, labels=single_object_human_labels_glimpse))
        self.summaries.append(
            image_summary("segment_completion", tf.nn.sigmoid(segment_completion)))

        return segment_completion_loss

    def _create_error_detection_task(self, image_glimpse, 
        single_object_machine_labels_glimpse, single_object_human_labels_glimpse,
        gpu_any_error):

        human_labels_error_prediction = self._estimator.error_prediction(
                tf.concat([single_object_human_labels_glimpse, image_glimpse],4))
            
        # We save computation by only running error_prediction on the machine labels
        # if there is an error on them.
        machine_labels_error_prediction = tf.cond(gpu_any_error,
                lambda:  self._estimator.error_prediction(
                    tf.concat([single_object_machine_labels_glimpse, image_glimpse],4)),
                lambda: map(tf.identity, human_labels_error_prediction))

        machine_labels_loss = tf.nn.sigmoid_cross_entropy_with_logits(
            logits=tf.reduce_sum(machine_labels_error_prediction[-1]),
            labels=tf.to_float(gpu_any_error))

        human_labels_loss = tf.nn.sigmoid_cross_entropy_with_logits(
            logits=tf.reduce_sum(human_labels_error_prediction[-1]),
            labels=tf.constant(0, dtype=tf.float32))

        return (machine_labels_loss + human_labels_loss,
         machine_labels_error_prediction, human_labels_error_prediction)

    def _create_error_localization_task(self, machine_labels_error_prediction,
        single_object_machine_labels_glimpse, human_labels_glimpse, any_error,
        human_labels_error_prediction):
        """
        We try to localize were the errors are for a correct input (`human_labels_error_prediction`),
        which should show no errors

        And we do the same for machine_labels_error_prediction, we should sometimes have an error
        (when any_error is true).
        """

        window_size =  [1,10,10,2,1]
        max_pool_ml_errors = tf.nn.max_pool3d(
            machine_labels_error_prediction[0],
            ksize=window_size, strides=window_size, padding="VALID")

        max_pool_hl_errors = tf.nn.max_pool3d(
            human_labels_error_prediction[0],
            ksize=window_size, strides=window_size, padding="VALID")


        def get_localized_errors():
            return tf.to_float(
                error_free_window_conv(
                single_object_machine_labels_glimpse, 
                tf.to_float(human_labels_glimpse),
                window_size=window_size)
            )

        ml_desired_errors = tf.cond(
                any_error,
                lambda: get_localized_errors(),
                lambda: tf.zeros_like(max_pool_hl_errors))

        error_localization_loss = tf.reduce_mean(tf.nn.sigmoid_cross_entropy_with_logits(
            logits=max_pool_ml_errors, labels=ml_desired_errors))

        error_localization_loss += tf.reduce_mean(tf.nn.sigmoid_cross_entropy_with_logits(
            logits=max_pool_hl_errors, 
            labels=tf.zeros_like(max_pool_hl_errors)))
        

        self.summaries.append(
            image_summary("error_localization_prediction", max_pool_ml_errors))
        self.summaries.append(
            image_summary("error_localization_desired_errors", ml_desired_errors))

        return error_localization_loss

    def _train_op(self):

        ema_loss = EMA(decay=0.99)
        ema_loss.update(self._loss)

        ema_segment_completion_loss = EMA(decay=0.99)
        ema_segment_completion_loss.update(self._segment_completion_loss)

        with tf.control_dependencies([self.step.assign_add(1)]):
            optimizer = tf.train.AdamOptimizer(0.0001, beta1=0.95, beta2=0.9995, epsilon=0.1)
            op = optimizer.minimize(8e5*self._loss + self._segment_completion_loss, 
                colocate_gradients_with_ops=True,
                var_list=tf.get_collection(tf.GraphKeys.TRAINABLE_VARIABLES))

            quick_summary_op = tf.summary.merge([
                tf.summary.scalar("loss", self._loss),
                tf.summary.scalar("segment_completion_loss", self._segment_completion_loss),
                tf.summary.scalar("ema_segment_completion_loss", ema_segment_completion_loss.val),
                tf.summary.scalar("ema_loss", ema_loss.val)])

            return op, quick_summary_op

    def _test_op(self):
        """
        Test op doesn't advance the step
        """
        ema_test_loss = EMA(decay=0.9)
        ema_test_loss.update(self._loss)

        ema_test_segment_completion_loss = EMA(decay=0.9)
        ema_test_segment_completion_loss.update(self._segment_completion_loss)
        quick_summary_op = tf.summary.merge([
            tf.summary.scalar("test_loss", self._loss),
            tf.summary.scalar("test_segment_completion_loss", self._segment_completion_loss),
            tf.summary.scalar("ema_test_segment_completion_loss", ema_test_segment_completion_loss.val),
            tf.summary.scalar("ema_test_loss", ema_test_loss.val)])
        return tf.no_op(), quick_summary_op
