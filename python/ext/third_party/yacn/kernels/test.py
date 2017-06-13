from __future__ import print_function

import os
os.environ["CUDA_VISIBLE_DEVICES"]="0"

import numpy as np
import tensorflow as tf
import timeit
import functools
from copy import deepcopy

reduce_equal_module = tf.load_op_library('./reduce_all_user_defined.so')
tf.reduce_all_user_defined = reduce_equal_module.reduce_all_user_defined

def compare(obj_0, obj_1, r):
    assert tf.reduce_all(
        tf.equal(obj_0, obj_1)).eval() == r

def compare_fast(obj_0, obj_1, r):
    assert tf.reduce_all_user_defined(
        tf.equal(obj_0, obj_1)).eval() == r 

with tf.Session() as sess:

    for device in ['/gpu:0']:
        with tf.device(device):
            for eq in [False, True]:

                rand_0 = np.random.uniform(low=0., high=100., size=(100,100,100,100))
                rand_1 = deepcopy(rand_0)
                rand_1[-1] += 1.0

                ph_0 = tf.placeholder(rand_0.dtype, shape=rand_0.shape)
                var_0 = tf.Variable(ph_0, trainable=False, collections=[])

                ph_1 = tf.placeholder(rand_1.dtype, shape=rand_1.shape)
                var_1 = tf.Variable(ph_1, trainable=False, collections=[])
                
                if eq:
                    print ('same')
                    sess.run(var_0.initializer, feed_dict={ ph_0: rand_0 })
                    sess.run(var_1.initializer, feed_dict={ ph_1: rand_0 })
                else:
                    print ('different')
                    sess.run(var_0.initializer, feed_dict={ ph_0: rand_0 })
                    sess.run(var_1.initializer, feed_dict={ ph_1: rand_1 })

                for i in range(3):
                    t = timeit.Timer(functools.partial(compare, var_0, var_1, eq)) 
                    print('tf.reduce_all '+ device + ' ' +  str(t.timeit(1)))
                    
                    t = timeit.Timer(functools.partial(compare_fast, var_0, var_1, eq)) 
                    print('tf.reduce_all_user_defined '+ device + ' ' +  str(t.timeit(1)))
