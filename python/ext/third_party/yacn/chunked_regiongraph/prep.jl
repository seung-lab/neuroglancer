push!(LOAD_PATH, dirname(@__FILE__))
include("../pre/Save.jl")
include("tasks.jl")

using Save

@pyimport neuroglancer.pipeline.task_queue as task_queue
@pyimport neuroglancer.pipeline.tasks as tasks 
tq = task_queue.TaskQueue(queue_server="pull-queue", n_threads=0)

counter = 0
map_chunks((10240:cx:65014, 7680:cy:43714, 0:cz:1001), 0, 1) do slices
  global counter
  counter += 1
	println(string(slices))
  task = tasks.EdgeTask(
							 "gs://neuroglancer/pinky40_v11/watershed",
               "gs://neuroglancer/pinky40_v11/watershed_mst_trimmed_sem_remap",
               "gs://neuroglancer/pinky40_v11/chunked_regiongraph",
               string(slices))
	tq[:insert](task)
end
println("Inserted $counter tasks")
tq[:wait]()
