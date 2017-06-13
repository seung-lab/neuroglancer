import os

import tensorflow as tf

if False:
    module_path =  os.path.abspath(os.path.dirname(__file__))
    reduce_all = tf.load_op_library(module_path + '/reduce_all_user_defined.so').reduce_all_user_defined
else:
    reduce_all = tf.reduce_all