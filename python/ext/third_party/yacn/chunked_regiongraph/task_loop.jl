push!(LOAD_PATH, dirname(@__FILE__))
push!(LOAD_PATH, joinpath(dirname(@__FILE__),"../pre"))

include("tasks.jl")

using PyCall
@pyimport neuroglancer.pipeline.task_queue as task_queue

tq = task_queue.TaskQueue(queue_server="pull-queue",n_threads=0)

while true
  try
    task = tq[:lease](tag="EdgeTask", leaseSecs=60)
    watershed_path = task[:watershed_path]
    agglomeration_path = task[:agglomeration_path]
    output_path = task[:output_path]
    chunk_position = eval(parse(task[:chunk_position]))
    max_x = min(last(chunk_position[1]), 65014)
    max_y = min(last(chunk_position[2]), 43714)
    max_z = min(last(chunk_position[3]), 1001)
    chunk_position = (chunk_position[1][1]:max_x, chunk_position[2][1]:max_y, chunk_position[3][1]:max_z)
    println(task)

    edge_task(watershed_path, agglomeration_path, output_path, chunk_position)
    
    tq[:delete](task)
  catch e
    if typeof(e) <: PyCall.PyError && contains(e.val, "QueueEmpty")
      sleep(1)
      continue
    else
      println("Error is $e")
      sleep(1)
    end
  end

end
