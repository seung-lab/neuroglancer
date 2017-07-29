# Cython compile instructions

from distutils.core import setup, Extension
from Cython.Build import cythonize

import numpy

# Use python setup.py build --inplace
# to compile

ext_module = Extension(
    "compress_segmentation",
    ["compress_segmentation.pyx"],
    language="c++",
    extra_compile_args=["-std=c++14"],
    extra_link_args=["-std=c++14"],
    include_dirs=[numpy.get_include()]
)

setup(
  ext_modules=cythonize(ext_module),
)

# g++ -O3 -std=c++14 compress_segmentation.cc -o compress_segmentation