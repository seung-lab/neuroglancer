
import tensorflow as tf

def collapse_image(x):
    ims=map(tf.unstack,tf.unstack(x))
    ims = map(lambda l: tf.concat(l,1),ims)
    ret=tf.expand_dims(tf.concat(ims,0),0)
    return ret

def image_summary(name, x, zero_one=False):
    if zero_one:
        x=tf.cast(x*255, tf.uint8)
    return tf.summary.image(name,tf.transpose(collapse_image(x), perm=[3,1,2,0]), max_outputs=6)

def image_slice_summary(name, x):
    patch_size=static_shape(x)[1:4]
    return tf.image_summary(name,x[0,patch_size[0]/2:patch_size[0]/2+1,:,:,:], max_images=6)

def colour_image_summary(name, x):
    return tf.image_summary(name,collapse_image(x), max_images=6)

class EMA():
    def __init__(self,decay):
        self.decay=decay
        self.val = tf.Variable(0.0, trainable=False)
    
    def update(self,x):
        with tf.control_dependencies([self.val.assign(self.val*self.decay + x*(1-self.decay))]):
            self.val=tf.identity(self.val)