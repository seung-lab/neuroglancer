#if GOOGLE_CUDA
#define EIGEN_USE_GPU
#include "third_party/eigen3/unsupported/Eigen/CXX11/Tensor"

template<class T>
struct SharedMemory
{
    __device__ inline operator       T *()
    {
        extern __shared__ int __smem[];
        return (T *)__smem;
    }

    __device__ inline operator const T *() const
    {
        extern __shared__ int __smem[];
        return (T *)__smem;
    }
};


template <unsigned int blockSize>
__global__ void ReduceAll(const bool* g_idata, bool* g_odata,const unsigned int n)
{
    bool *sdata = SharedMemory<bool>();

    // perform first level of reduction,
    // reading from global memory, writing to shared memory
    unsigned int tid = threadIdx.x;
    unsigned int i = blockIdx.x*blockSize*2 + threadIdx.x;
    unsigned int gridSize = blockSize*2*gridDim.x;

    bool all = true;
    // we reduce multiple elements per thread.  The number is determined by the
    // number of active thread blocks (via gridDim).  More blocks will result
    // in a larger gridSize and therefore fewer elements per thread
    while (i < n)
    {
        all &= g_idata[i];

        // ensure we don't read out of bounds -- this is optimized away for powerOf2 sized arrays
        if (i + blockSize < n)
            all &= g_idata[i+blockSize];
        i += gridSize;
    }

    // each thread puts its local sum into shared memory
    sdata[tid] = all;
    __syncthreads();


    // do reduction in shared mem
    if ((blockSize >= 512) && (tid < 256))
        sdata[tid] &= sdata[tid + 256];

    __syncthreads();
    if ((blockSize >= 256) &&(tid < 128))
        sdata[tid] &= sdata[tid + 128];

     __syncthreads();

    if ((blockSize >= 128) && (tid <  64))
       sdata[tid] &= sdata[tid +  64];

    __syncthreads();
    if ((blockSize >= 64) && (tid < 32))
        sdata[tid] &= sdata[tid + 32];

    __syncthreads();
    if ((blockSize >= 32) && (tid < 16))
        sdata[tid] &= sdata[tid + 16];

    __syncthreads();
    if ((blockSize >= 16) && (tid <  8))
        sdata[tid] &= sdata[tid +  8];

    __syncthreads();
    if ((blockSize >= 8) && (tid <  4))
        sdata[tid] &= sdata[tid +  4];

    __syncthreads();
    if ((blockSize >= 4) && (tid <  2))
        sdata[tid] &= sdata[tid +  2];

    __syncthreads();
    if ((blockSize >= 2) && ( tid <  1))
        sdata[tid] &= sdata[tid +  1];

    __syncthreads();
    // write result for this block to global mem
    if (tid == 0) g_odata[blockIdx.x] = sdata[tid];
}

unsigned int ilog2(int n) {
    // integer log 2
    unsigned int l = 0;
    while (n >>= 1) ++l;
    return l;
}

std::tuple<int, int> chooseBlockAndThreads(const unsigned int size) {
    const int maxThreads = 256;
    const int maxBlocks = 64;
    int blocks = min(maxBlocks, size/(maxThreads*2) + 1);
    int threads = 0; // number of threads per block
    if (blocks == 1) {
        threads = pow(2, ilog2(size));
    } else {
        threads = maxThreads;
    }
    return std::make_tuple(blocks, threads);
}

void reduce(int blocks, int threads, const bool* d_in, bool* d_odata,const unsigned int size) {
    // when there is only one warp per block, we need to allocate two warps
    // worth of shared memory so that we don't index shared memory out of bounds
    dim3 dimBlock(threads, 1, 1);
    dim3 dimGrid(blocks, 1, 1);

    int smemSize = (threads <= 32) ? 2 * threads * sizeof(bool) : threads * sizeof(bool);
    switch (threads)
    {
        case 256:
            ReduceAll<256><<< dimGrid, dimBlock, smemSize >>>(d_in, d_odata, size);
            break;

        case 128:
            ReduceAll<128><<< dimGrid, dimBlock, smemSize >>>(d_in, d_odata, size);
            break;

        case 64:
            ReduceAll< 64><<< dimGrid, dimBlock, smemSize >>>(d_in, d_odata, size);
            break;

        case 32:
            ReduceAll< 32><<< dimGrid, dimBlock, smemSize >>>(d_in, d_odata, size);
            break;

        case 16:
            ReduceAll< 16><<< dimGrid, dimBlock, smemSize >>>(d_in, d_odata, size);
            break;

        case  8:
            ReduceAll<  8><<< dimGrid, dimBlock, smemSize >>>(d_in, d_odata, size);
            break;

        case  4:
            ReduceAll<  4><<< dimGrid, dimBlock, smemSize >>>(d_in, d_odata, size);
            break;

        case  2:
            ReduceAll<  2><<< dimGrid, dimBlock, smemSize >>>(d_in, d_odata, size);
            break;

        case  1:
            ReduceAll<  1><<< dimGrid, dimBlock, smemSize >>>(d_in, d_odata, size);
            break;
    }
}

void ReduceKernelLauncher(const bool* d_in, const unsigned int size, bool* d_out) {

    auto t = chooseBlockAndThreads(size);
    int threads = std::get<0>(t);
    int blocks = std::get<1>(t);


    bool* d_odata = nullptr;
    cudaMalloc((void **) &d_odata, blocks*sizeof(bool));
    cudaMemset(d_odata, 0, blocks*sizeof(bool));

    reduce(blocks, threads, d_in, d_odata, size);
    
    bool* h_odata = (bool*) malloc(blocks*sizeof(bool));
    cudaMemcpy(h_odata, d_odata, blocks*sizeof(bool), cudaMemcpyDeviceToHost);

    bool h_out = true;
    for(unsigned int b = 0; b < blocks; b++) {
        h_out &= h_odata[b];
    }
    cudaMemcpy(d_out, &h_out, sizeof(bool), cudaMemcpyHostToDevice);

    free(h_odata);
    cudaFree(d_odata);
}

#endif
