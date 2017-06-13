TF_INC=$(python -c 'import tensorflow as tf; print(tf.sysconfig.get_include())') 

rm reduce_all_user_defined.so

nvcc -std=c++11 -c -o reduce_all_user_defined_gpu.cu.o reduce_all_user_defined_gpu.cu.cc \
-I $TF_INC -D GOOGLE_CUDA=1 -x cu -Xcompiler -fPIC -D_MWAITXINTRIN_H_INCLUDED --expt-relaxed-constexpr -Wno-deprecated-gpu-targets
g++ -std=c++11 -shared -o reduce_all_user_defined.so reduce_all_user_defined.cc  \
reduce_all_user_defined_gpu.cu.o -I $TF_INC -fPIC -D_GLIBCXX_USE_CXX11_ABI=0 #-lcudart 

