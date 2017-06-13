from __future__ import print_function

import numpy as np
import tensorflow as tf

from yacn.nets.localization import error_free_window_conv, error_free

def create_5d(vals, axis=3):
    reshape_to = [1,1,1,1,1]
    reshape_to[axis] = 4
    reshape_to[axis+1] = len(vals) / 4
    arr = np.array(vals).reshape(reshape_to).astype(np.float32)
    return tf.constant(arr, dtype=tf.float32)


class ErrorLocalizationWindow(tf.test.TestCase):
    """
    Single window
    """
    def assert_error(self, obj_ml, hl, has_error):
        self.assertEqual(error_free(obj_ml, hl).eval() , has_error)
        self.assertEqual(error_free_window_conv(obj_ml, hl,  window_size=[1,1,1,4,1]).eval()[0,0,0,0], has_error)

    def testSame(self):
        with self.test_session():
            obj = create_5d([1,1,0,0])
            human_labels = create_5d([5,5,0,6])
            self.assert_error(obj, human_labels, True)

    def testOutside(self):
        with self.test_session():
            obj = create_5d([0,0,0,0])
            human_labels = create_5d([5,5,0,6])
            self.assert_error(obj, human_labels, True)

    def testMergerBoundary(self):
        with self.test_session():
            obj = create_5d([1,1,1,0])
            human_labels = create_5d([5,5,0,6])
            self.assert_error(obj, human_labels, False)

    def testMerger(self):
        with self.test_session():
            obj = create_5d([1,1,0,1])
            human_labels = create_5d([5,5,0,6])
            self.assert_error(obj, human_labels, False)

    def testSplit(self):
        with self.test_session():
            obj = create_5d([1,0,0,0])
            human_labels = create_5d([5,5,0,6])
            self.assert_error(obj, human_labels, False)

    def testMergerSplit(self):
        with self.test_session():
            obj = create_5d([1,0,0,1])
            human_labels = create_5d([5,5,0,6])
            self.assert_error(obj, human_labels, False)


class ErrorLocalization(tf.test.TestCase):
    """
    Non Overlapping Window
    """
    cases = [
        ((1,1,0,0),True),
        ((0,0,0,0),True),
        ((1,1,1,0),False),
        ((1,1,0,1),False),
        ((1,1,1,0),False),
        ((1,0,0,0),False),
        ((1,0,0,1),False)]

    def combinations(self):
        for chunk1, result1 in ErrorLocalization.cases:
            for chunk2, result2 in ErrorLocalization.cases:
                yield (chunk1 + chunk2), [result1, result2]

    def test_axes_nooverlapping(self):
        with self.test_session():
            for a in range(1,3):
                for obj_val, expected in self.combinations():
                    obj = create_5d(obj_val, axis=a)
                    human_labels = create_5d([5,5,0,6,5,5,0,6], axis=a)

                    window_size = [1,1,1,1,1]
                    window_size[a] = 2
                    window_size[a+1] = 2
                    result = error_free_window_conv(
                        obj, human_labels, window_size=window_size)
                    result = result.eval().flatten()
                    self.assertTrue(
                        np.all(result == expected))

    def test_axes_overlapping(self):
        with self.test_session():
            obj = create_5d([1,1,0,0,1,1,0,0], axis=1)
            human_labels = create_5d([5,5,0,6,5,5,0,6], axis=1)

            #TODO implement windows overlapping
            # result = error_free_window_conv(
            #     obj, human_labels, window_size=window_size)
          
if __name__ == '__main__':
    tf.test.main()