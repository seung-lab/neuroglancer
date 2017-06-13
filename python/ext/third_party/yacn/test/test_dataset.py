from __future__ import print_function

import numpy as np
import tensorflow as tf

from yacn.nets.dataset import static_constant_multivolume


class TestDataset(tf.test.TestCase):
    
    def test_multi(self):
        with self.test_session() as sess:
            l = range(10)
            l = map(lambda i: np.array([i,i+1], dtype=np.int32), l)
            stm = static_constant_multivolume(sess, l, patch_size=[1])
            for i in range(10):
                self.assertEqual(stm[i,0].eval(), i)
                self.assertEqual(stm[i,1].eval(), i+1)

if __name__ == '__main__':
    tf.test.main()