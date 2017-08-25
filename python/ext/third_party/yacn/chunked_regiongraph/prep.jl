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
               "gs://neuroglancer/pinky40_v11/mean_0.27_segmentation",
               "gs://neuroglancer/pinky40_v11/chunked_regiongraph",
               string(slices))
	tq[:insert](task)
end
println("Inserted $counter tasks")
tq[:wait]()


# s=pl.Storage("s3://neuroglancer/pinky40_v11/chunked_regiongraph")
# const edges = Set{Tuple{Label,Label}}()
# const vertices = Set{Label}()
# map_chunks((30000:cx:35000,20000:cy:25000, 0:cz:500), 0, 1) do slices
# 	content=s[:get_file](file_path="$(slices_to_str(slices))_edges.txt")
# 	x=eval(parse(content))
# 	for t in x
# 		push!(edges,t)
# 	end

# 	content=s[:get_file](file_path="$(slices_to_str(slices))_vertices.txt")
# 	x=eval(parse(content))
# 	for t in x
# 		push!(vertices,t)
# 	end
# end
# println(size(collect(edges)))

# Save.save("~/testing/chunked_edges.jls",edges)
# Save.save("~/testing/chunked_vertices.jls",vertices)
