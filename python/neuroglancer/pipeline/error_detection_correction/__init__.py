#!/usr/bin/env python2
from __future__ import absolute_import

from datetime import datetime
import logging
import time
import os.path

from . import enviroment #has to happen before tf is imported(maybe)

import tensorflow as tf
from tensorflow.python.client import timeline
from tqdm import tqdm


class Experiment(object):
    """
    Provides inputs and desired labels to Estimators
    """
    def _read_dataset(self):
        self._dataset.initialize(self._sess)

    def _get_random_focus(self, vol_id):
        """
        given a volume id, it gets a random sample from the list of points to sample
        for that given volume.
        """
        sample = self._dataset['samples'][vol_id,('RAND',0)]
        reshaped_sample = tf.reshape(sample,(3,))
        focus = tf.concat([[0], reshaped_sample ,[0]],0) # vector of the from [0 x y z 0]

        #for debugging
        # focus = tf.Print(focus,[vol_id, focus], message="focus", summarize=10)
        return focus

    def _create_optimizer(self):
        """
        The gradients created by the optimizer will be computed in the same
        place the forward pass is done
        """
        self.iter_op, self.quick_summary_op = tf.cond(self._is_train_iter,
                self._train_op, self._test_op)

        self.long_summary_op = tf.summary.merge(self.summaries)

        init = self.get_uninitialized_variables()
        self.saver = tf.train.Saver(
            var_list= tf.get_collection(tf.GraphKeys.TRAINABLE_VARIABLES),
            keep_checkpoint_every_n_hours=2)

        self._sess.run(init)
 
    def get_uninitialized_variables(self):
        """Get uninitialized variables as a list.
        """
        variables = tf.global_variables()
        init_flag = self._sess.run([tf.is_variable_initialized(v) for v in variables])
        return [v.initializer for v, f in zip(variables, init_flag) if not f]



class Estimator(object):

    def fit(train_input_fn):
        pass

    def evaluate(eval_input_fn):
        pass

class Runner(object):
    """
    Runs experiments

    TODO the runner should hold the session and not the experiment
    It should also decide which devices to run it on.
    """
    def __init__(self, experiment, devices, checkpoint_path=None):

        self._experiment = experiment
        self._create_session()
        self.is_train_iter = tf.placeholder(shape=[], dtype=tf.bool)
        self.step = tf.Variable(0, trainable=False, name="step")
        self._experiment.build_graph(self.sess, devices, self.is_train_iter, self.step)

        self._restore(checkpoint_path) if checkpoint_path else self._initialize()

        self._summary_writer = tf.summary.FileWriter(
            self._logdir, graph=self.sess.graph)

    def _create_session(self):
        config = tf.ConfigProto(
            allow_soft_placement=True,
            #gpu_options=tf.GPUOptions(
            #  per_process_gpu_memory_fraction=0.9,
            #  allow_growth=True),
            #log_device_placement=True,
        )
        # makes no difference
        # config.graph_options.optimizer_options.global_jit_level = tf.OptimizerOptions.ON_1

        self.sess = tf.Session(config=config)
        self.run_metadata = tf.RunMetadata()

    def _initialize(self):
        date = datetime.now().strftime("%j-%H-%M-%S")
        self._logdir = os.path.expanduser("~/experiments/{}_{}/".format(
            date, type(self._experiment).__name__))

        logging.info('logging to {}'.format(self._logdir))
        if not os.path.exists(self._logdir):
            os.makedirs(self._logdir)

  
    def _restore(self, checkpoint_path):
        logging.info('Restoring checkpoint')

        self._logdir = os.path.basename(checkpoint_path)
        self._experiment.saver.restore(self.sess, checkpoint_path)

    def train(self, n_steps = 100000,
        quick_summary_train_interval = 5,
        quick_summary_test_interval = 10,
        long_summary_train_interval = 50,
        long_summary_test_interval = 50,
        profile_interval = 500,
        checkpoint_interval = 1000):
        """
        If we restard training i won't be the less than
        self._experiment.step

        step is only advance on train operations
        so we do first test and then train otherwise we would
        write two summaries with the same step which is not allowed
        """
        last_step = 0
        i = 0
        progressbar = tqdm(total=n_steps)
        while last_step < n_steps:
            i += 1
            if i % quick_summary_test_interval == 0:
                step , _ , summary_proto = self.sess.run(
                    [self.step, 
                     self._experiment.iter_op,
                     self._experiment.quick_summary_op],
                    feed_dict={self.is_train_iter: False})
                self._summary_writer.add_summary(summary_proto, step)

            if i % quick_summary_train_interval == 0:
                step , _ , summary_proto = self.sess.run(
                    [self.step, 
                     self._experiment.iter_op,
                     self._experiment.quick_summary_op],
                    feed_dict={self.is_train_iter: True})
                self._summary_writer.add_summary(summary_proto, step)

            if i % long_summary_test_interval == 0:
                step , _ , summary_proto = self.sess.run(
                    [self.step, 
                     self._experiment.iter_op,
                     self._experiment.long_summary_op],
                    feed_dict={self.is_train_iter: False})
                self._summary_writer.add_summary(summary_proto, step)

            if i % long_summary_train_interval == 0:
                step , _ , summary_proto = self.sess.run(
                    [self.step, 
                     self._experiment.iter_op,
                     self._experiment.long_summary_op],
                    feed_dict={self.is_train_iter: True})
                self._summary_writer.add_summary(summary_proto, step)

            if i % profile_interval == 0 and False: #seems to be too large of a message
                step , _  = self.sess.run(
                    [self.step, 
                     self._experiment.iter_op],
                     options=tf.RunOptions(trace_level=tf.RunOptions.FULL_TRACE), 
                     run_metadata=self.run_metadata, 
                     feed_dict={self.is_train_iter: True})
                trace = timeline.Timeline(step_stats=self.run_metadata.step_stats)
                filepath = '{}/timeline-step-{}.ctf.json'.format(self._logdir, step)
                with  open(filepath, 'w') as f:
                    f.write(trace.generate_chrome_trace_format(show_memory=True, show_dataflow=True))
                self._summary_writer.add_run_metadata(self.run_metadata, str(step))

            if i % checkpoint_interval == 0:
                logging.info('saving checkpoint')
                step = self.sess.run(self.step)
                filename = '{}/step-{}.ckpt'.format(self._logdir, step)
                self._experiment.saver.save(
                    self.sess,
                    filename,
                    write_meta_graph=False)
                self._summary_writer.flush()

            # train
            step, _ = self.sess.run(
                [self.step, self._experiment.iter_op],
                 feed_dict={self.is_train_iter: True})

            progressbar.update(n=step-last_step)
            last_step = step