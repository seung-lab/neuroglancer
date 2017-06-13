import tensorflow as tf

from yacn.nets.loss_functions import downsample
from yacn.kernels.graph_naming import tfscope

def error_free_window_conv(obj_ml, hl, window_size=[1,2,2,2,1], window_overlap=[0,0,0,0,0]):
    """
    Given an image of the object in the machine labels (composed of a set
    of supervoxels), and the human labels segmentation.
    We divide the image in (hl.shape / window_size) windows and check if there 
    are errors on them.

    We only want to mark as errors the windows that contains the interface of a
    merge or an split error.

    The reason for marking interfaces is to brake symmetry. Imagine that we wanted to 
    mark the whole object as wrong instead of the interfaces, which of the two objets
    do we mark as wrong if we have an two perperndicular neurites and the merge zone is
    in the center of the field of view?

    When using windows to detect errors, if the windows are larger than the average error
    size, the value in this window is a measure of confident
    If we were predicting pixels directly, and if the error is hard to localize
    a low value, might mean that the network is highly confident that there is an error 
    there, but not sure where the error is exactly.
    
    All inputs correspond to 5 dimensions
    [batch, in_depth, in_height, in_width, in_channels]
    Args:
        obj_ml (tensor): 1's where there is an object and 0s otherwise,
        aka single_object_machine_labels
        hl (tensor): tensor of segment ids of human labels
        window_size (list, optional): Description
        window_overlap (list, optional): Description
    
    Returns:
        tensor: Bool value for every window
    
    Raises:
        NotImplementedError: if a window_overlap != zeroes is provided
    """
    if sum(window_overlap) != 0:
        raise NotImplementedError("We don't yet support window overlapping")

    fsize = window_size[1:] + [1] 
    strides = map(lambda s,o: s-o, zip(window_size, window_overlap))


    human_labels_intersection_obj =  tf.multiply(obj_ml, hl,
        name='human_labels_intersection_obj')

    # We select the larget human label id that intersects with the obj for no good reason
    # we could have also chosen any other id that intersects with the object
    downsample_max_id = tf.nn.max_pool3d(human_labels_intersection_obj,
        ksize=window_size, strides=strides, padding="VALID",
        name="downsample_max_id")


    #We now upsample the max_id to that we can compare it with hl
    #Which will give us a boolean mask of the object in the human label
    #that has the id `downsample_max_id`
    hl_max_id = tf.nn.conv3d_transpose(downsample_max_id, filter=tf.ones(fsize),
            output_shape=hl.shape, strides=strides, padding='VALID')
    hl_obj = tf.to_float(tf.equal(hl_max_id, hl))

    #now that we have two boolen masks (hl_obj, ml_obj) we want to know if they are
    #exactly the same
    hl_sum = tf.nn.conv3d(hl_obj, filter=tf.ones(fsize), strides=strides, padding="VALID")
    ml_sum = tf.nn.conv3d(obj_ml, filter=tf.ones(fsize), strides=strides, padding="VALID")
    hl_ml_sum = tf.nn.conv3d(obj_ml * hl_obj, filter=tf.ones(fsize), strides=strides, padding="VALID")
    is_segmentation_equal = tf.logical_and( tf.equal(hl_sum, hl_ml_sum),  tf.equal(ml_sum, hl_ml_sum))
    is_ml_empty = tf.less(ml_sum , 0.5)


    return tf.logical_or(is_ml_empty , is_segmentation_equal)

def error_free(single_object_machine_labels, human_labels):
    """Does the object have an error?

       If there is no error and 
    
    Args:
        single_object_machine_labels (3d tensor): Values are either 1 or 0
        human_labels (3d tensor): Value are positive integers
    """
    obj_flatten = tf.reshape(single_object_machine_labels, [-1])
    human_labels_flatten = tf.reshape(human_labels, [-1])

    obj_index = tf.to_int32(tf.argmax(obj_flatten, axis=0))
    human_labels_id = human_labels_flatten[obj_index]

    obj_human_labels = tf.to_float(tf.equal(human_labels_flatten, human_labels_id))
    obj_prediction_error = tf.to_float(tf.reduce_all(tf.equal(obj_flatten,obj_human_labels)))

    return tf.maximum(obj_prediction_error, 1-obj_flatten[obj_index])

def has_error(obj, human_labels):
    return 1-error_free(obj,human_labels)

def localized_errors(obj, human_labels, ds_shape, expander):
    """
    Same input and output as `error_free_window_conv`
    This one is more flexible because it allows for overlapping 
    windows. But it creates a really large number of operations.
    """
    return 1-(downsample([obj,human_labels], ds_shape, expander, error_free))