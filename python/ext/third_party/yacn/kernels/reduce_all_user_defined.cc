#include "tensorflow/core/framework/op.h"
#include "tensorflow/core/framework/shape_inference.h"
#include "tensorflow/core/framework/op_kernel.h"

using namespace tensorflow;

REGISTER_OP("ReduceAllUserDefined")
    .Input("input: bool")
    .Output("output: bool")
    .SetShapeFn([](::tensorflow::shape_inference::InferenceContext* c) {
      c->set_output(0,  c->Scalar());
      return Status::OK();
    });

void ReduceKernelLauncher(const bool* d_in, const unsigned int n, bool* d_out);

class ReduceAllUserDefinedOpGPU : public OpKernel {
 public:
  explicit ReduceAllUserDefinedOpGPU(OpKernelConstruction* context) : OpKernel(context) {}

  void Compute(OpKernelContext* c) override {

    Tensor* output = nullptr;
    OP_REQUIRES_OK(c, c->allocate_output(0, TensorShape({}), &output));

    auto in =  c->input(0).flat<bool>();
    ReduceKernelLauncher(in.data(),
                         in.size(),
                         output->flat<bool>().data());
  }
};

REGISTER_KERNEL_BUILDER(Name("ReduceAllUserDefined").Device(DEVICE_GPU), ReduceAllUserDefinedOpGPU);
