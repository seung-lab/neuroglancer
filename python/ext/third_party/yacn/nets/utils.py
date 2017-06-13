from __future__ import absolute_import

import numpy as np
import tensorflow as tf
import os
from datetime import datetime
from neuroglancer.pipeline.error_detection_correction.interrupt_handler import DelayedKeyboardInterrupt
from tensorflow.python.client import timeline, device_lib
import time
import gc
from subprocess import call

dtype=tf.float32
shape_dict3d={}
shape_dict2d={}
shape_dictz={}

class Model():

    def restore(self, modelpath):
        modelpath = os.path.realpath(os.path.expanduser(modelpath))
        self.saver.restore(self.sess, modelpath)

    def train(self, nsteps=100000, checkpoint_interval=1000, test_interval=10):
        self.init_log()
        for i in xrange(nsteps):
            try:
                with DelayedKeyboardInterrupt():
                    #if a keyboard interrupt happens during this context
                    #it get catch and reraised at the end
                    self._run_iteration(i, checkpoint_interval, test_interval)
                    
            except KeyboardInterrupt:
                break
                #self.interrupt()

    def _run_iteration(self, i, checkpoint_interval, test_interval):
        """
        TODO when does i == -1 happen? 
        """
        t = time.time()
        is_train_iter = i % test_interval != 0 
        step = self.sess.run(self.step)
        if i == -1 or False:
            _, quick_summary = self.sess.run(
                    [self.iter_op, self.quick_summary_op], 
                    options=tf.RunOptions(trace_level=tf.RunOptions.FULL_TRACE), 
                    run_metadata=self.run_metadata, 
                    feed_dict={self.is_train_iter: is_train_iter})

            trace = timeline.Timeline(step_stats=self.run_metadata.step_stats)
            with  open('timeline.ctf.json', 'w') as f:
                f.write(trace.generate_chrome_trace_format(show_memory=True, show_dataflow=True))
            self.summary_writer.add_run_metadata(self.run_metadata, 'step%d' % i)

        else:

            _, quick_summary = self.sess.run(
                    [self.iter_op, self.quick_summary_op], feed_dict={self.is_train_iter: is_train_iter})

        elapsed = time.time() - t
        print("elapsed: ", elapsed)
        # self.summary_writer.add_summary(quick_summary, step)
        if i % checkpoint_interval == 0:
            print("checkpointing...")
            self.saver.save(self.sess, self.logdir + "model" + str(step) + ".ckpt", write_meta_graph=False)
            self.summary_writer.add_summary(self.sess.run(self.summary_op, 
                feed_dict={self.is_train_iter: True}), step)
            self.summary_writer.flush()
            call(["touch",self.logdir+"model"+str(step) + ".ckpt"])
            print("done")

    def init_log(self):
        date = datetime.now().strftime("%j-%H-%M-%S")
        filename=self.get_filename()
        if self._name is None:
            print ('What do you want to call this experiment?')
            self._name=raw_input('run name: ')
        exp_name = date + '-' + self._name

        logdir = os.path.expanduser("~/experiments/{}/{}/".format(filename,exp_name))
        self.logdir = logdir

        print('logging to {}'.format(logdir))
        if not os.path.exists(logdir):
            os.makedirs(logdir)
        self.summary_writer = tf.summary.FileWriter(
            logdir, graph=self.sess.graph)
        print ('log initialized')

    
class NpVolume():
    def __init__(self, A, patch_size,indexing='CENTRAL'):
        self.A=A
        self.patch_size=patch_size
        self.indexing=indexing

    def focus_to_slices(self, focus):
        patch_size = self.patch_size
        focus = np.array(focus,dtype=np.int32)
        if self.indexing == 'CENTRAL':
            corner = np.array(focus) - np.array([x/2 for x in patch_size],dtype=np.int32)
        elif self.indexing =='CORNER':
            corner = focus
        else:
            raise Exception("bad indexing scheme")
        ret = tuple(slice(c,c+p) for c,p in zip(corner,patch_size))
        return ret

    def __getitem__(self, focus):
        return self.A[self.focus_to_slices(focus)]

    def __setitem__(self, focus, val):
        self.A[self.focus_to_slices(focus)] = val

def random_row(A):
    index=tf.random_uniform([],minval=0,maxval=static_shape(A)[0],dtype=tf.int32)
    return A[index,:]

def unique(x):
    tmp0 = tf.reshape(x, [-1])

    #Ensure that zero is named zero
    tmp = tf.unique(tmp0)[1] + 1
    tmp = tmp * tf.to_int32(tf.not_equal(tmp0, 0))

    return tf.reshape(tmp, static_shape(x))

#Computes the unique elements in x excluding zero. Returns the result as an indicator function on [0...maxn]
def unique_list(x,maxn):
    return tf.to_float(tf.minimum(tf.unsorted_segment_sum(tf.ones_like(x), x, maxn),1)) * np.array([0]+[1]*(maxn-1))

def KL(a,b):
    return -a*tf.log(b/a)-(1-a)*tf.log((1-b)/(1-a))

def local_error(ground_truth, proposal):
    T=tf.reduce_sum(ground_truth)
    P=tf.reduce_sum(proposal)
    S=tf.reduce_sum(proposal*ground_truth)
    return [T, P, S]

def random_occlusion(target):
    """
    It randomly blacks outs half of an axis
    """
    target = tf.to_float(target)
    patch_size = static_shape(target)[1:4]
    reshaped_target = tf.reshape(target,patch_size)

    xmask = tf.to_float(tf.concat([
        tf.ones((patch_size[0]-patch_size[0]/2,patch_size[1],patch_size[2])),
        tf.zeros((patch_size[0]/2,patch_size[1],patch_size[2]))],0))
    ymask = tf.to_float(tf.concat([
        tf.ones((patch_size[0],patch_size[1]-patch_size[1]/2,patch_size[2])),
        tf.zeros((patch_size[0],patch_size[1]/2,patch_size[2]))],1))
    zmask = tf.to_float(tf.concat([
        tf.ones((patch_size[0],patch_size[1],patch_size[2]-patch_size[2]/2)),
        tf.zeros((patch_size[0],patch_size[1],patch_size[2]/2))],2))
    full = tf.to_float(tf.ones(patch_size))

    xmasks = tf.stack([xmask, 1-xmask, full])
    ymasks = tf.stack([ymask, 1-ymask, full])
    zmasks = tf.stack([zmask, 1-ymask, full])

    xchoice = tf.reshape(tf.one_hot(
        tf.multinomial([0.3*tf.log(0.001+tf.reduce_sum(
            xmasks*tf.stack([reshaped_target]),
            reduction_indices=[1,2,3]))],1),3),(3,1,1,1))
    ychoice = tf.reshape(tf.one_hot(
        tf.multinomial([0.3*tf.log(0.001+tf.reduce_sum(
            ymasks*tf.stack([reshaped_target]),
            reduction_indices=[1,2,3]))],1),3),(3,1,1,1))
    zchoice = tf.reshape(tf.one_hot(
        tf.multinomial([0.3*tf.log(0.001+tf.reduce_sum(
            zmasks*tf.stack([reshaped_target]),
            reduction_indices=[1,2,3]))],1),3),(3,1,1,1))

    mask =  tf.reduce_sum(xmasks*xchoice, reduction_indices=0) * \
            tf.reduce_sum(ymasks*ychoice, reduction_indices=0) * \
            tf.reduce_sum(zmasks*zchoice, reduction_indices=0)
    mask = tf.reshape(mask,[1]+patch_size+[1])
    return mask*target

def trimmed_sigmoid(logit):
    return 0.00001+0.99998*tf.nn.sigmoid(logit)

def static_constant_variable(x, fd):
    placeholder = tf.placeholder(tf.as_dtype(x.dtype), shape=x.shape)
    fd[placeholder]=x
    return tf.Variable(placeholder,name="scv")

def bump_map(patch_size):
    tmp=np.zeros(patch_size)
    I,J,K=tmp.shape
    for i in xrange(I):
        for j in xrange(J):
            for k in xrange(K):
                tmp[i,j,k]=3*bump_logit((i+1.0)/(I+2.0),(j+1.0)/(J+2.0),(k+1.0)/(K+2.0))
    tmp-=np.max(tmp)
    return np.exp(tmp)

def bump_logit(x,y,z):
    t=1
    return -(x*(1-x))**(-t)-(y*(1-y))**(-t)-(z*(1-z))**(-t)

def rand_bool(shape, prob=0.5):
    return tf.less(tf.random_uniform(shape),prob)

def subsets(l):
    if len(l)==0:
        return [[]]
    else:
        tmp=subsets(l[1:])
        return tmp + map(lambda x: [l[0]] + x, tmp)

def lrelu(x):
    return tf.nn.relu(x) - tf.log(-tf.minimum(x,0)+1)

def prelu(x,n):
    return tf.nn.relu(x) - n*tf.pow((tf.nn.relu(-x)+1),1.0/n) + n

def conditional_map(fun,lst,cond,default):
    return [tf.cond(c, lambda: fun(l), lambda: default) for l,c in zip(lst, cond)]

def covariance(population, mean, weight):
    population = population - tf.reshape(mean,[1,-1])
    return matmul(tf.transpose(population), population)/weight

def equal_to_centre(X):
    """
    Return a tensor with the same shape as a the input
    but with 1.0 where it had the same value as the
    value of the center pixel and 0.0 otherwise
    """
    return tf.to_float(tf.equal(extract_central(X),X))

def norm(A):
    return tf.reduce_sum(tf.square(A),reduction_indices=[3],keep_dims=True)

def block_cat(A,B,C,D):
    n=len(A.get_shape())
    return tf.concat([tf.concat([A,B],n-1),tf.concat([C,D],n-1)],n-2)

def vec_cat(A,B):
    n=len(A.get_shape())
    return tf.concat([A,B],n-2)

def matmul(*l):
    return reduce(tf.matmul,l)

def batch_transpose(A):
    n=len(A.get_shape())
    perm = range(n-2)+[n-1,n-2]
    return tf.transpose(A,perm=perm)

def categorical(logits, selection_logit=False):
    s=static_shape(logits)
    logits = tf.reshape(logits,[-1])
    U=tf.random_uniform(logits.get_shape())
    x=tf.to_int32(tf.argmax(logits - tf.log(-tf.log(U)),0))
    ret = linear_to_ind(x,s)
    if selection_logit:
        return ret, logits[x]
    else:
        return ret

def vector_argmax(A):
    n=len(static_shape(A))
    if n == 0:
        assert False
    elif n == 1:
        return [tf.argmax(A,0)]
    else:
        #first we need to locate which subarray contains the maximum
        maxval = tf.argmax(tf.reduce_max(A,reduction_indices=range(1,n)),0)
        return [maxval] + vector_argmax(tf.squeeze(tf.slice(A,[maxval]+[0]*(n-1),[1]+static_shape(A)[1:])))

def categorical2(logits):
    s=static_shape(logits)
    U=tf.random_uniform(logits.get_shape())
    return tf.to_int32(tf.stack(vector_argmax(logits - tf.log(-tf.log(U)))))
    
def linear_to_ind(a,shape):
    t=[]
    for i in reversed(shape):
        t.insert(0,tf.mod(a,i))
        a=tf.floordiv(a,i)
    
    #should t be reversed?
    return t

def logdet(M):
    return tf.reduce_sum(tf.log(tf.self_adjoint_eig(M)[0,:]))


def pad_shape(A):
    return np.reshape(A, list(np.shape(A)) + [1])

def identity_matrix(n):
    return tf.diag(tf.ones([n]))

def static_shape(x):
    return [x.value for x in x.get_shape()]

def indicator(full, on_vals, maxn=10000):
    tmp=tf.scatter_nd(on_vals, tf.ones_like(on_vals), [maxn])
    return tf.gather_nd(on_vals,full)


#applies fs, starting with the left
def compose(*fs):
    return lambda x: reduce(lambda v, f: f(v), fs, x)

def cum_compose(*fs):
    return lambda x: reduce(lambda vs, f: vs + [f(vs[-1])], fs, [x])

def reduce_spatial(x):
    return tf.reduce_sum(x, axis=[1,2,3], keep_dims=False)

def range_expander(stride, size):
    def f(t):
        x,y=t.start,t.stop
        return slice(x*stride, y*stride + size-stride)
    return f
    
def range_tuple_expander(strides, size):
    fs = [range_expander(stride, siz) for stride, siz in zip(strides, size)]
    def f(ts):
        return tuple(f(t) for f,t in zip(fs, ts))
    return f

def shape_to_slices(s):
    return map(lambda x: slice(0,x,None), s)

#assumes step size 1
def slices_to_shape(s):
    return map(lambda x: x.stop-x.start,s)

def occlude_correct(errors, human_labels):
    max_errors = tf.unsorted_segment_max(errors,human_labels)
    return tf.gather_nd(max_errors, human_labels)

from subprocess import Popen, PIPE
def zenity_workaround():
    process = Popen(["zenity","--file-selection"], stdout=PIPE)
    (output,err) = process.communicate()
    exit_code=process.wait()
    return output.strip()

def random_sample(A):
    s=static_shape(A)
    assert len(s)==1
    return A[tf.random_uniform([],minval=0, maxval=s[0],dtype=tf.int32)]
