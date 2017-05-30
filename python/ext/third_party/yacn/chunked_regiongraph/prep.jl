push!(LOAD_PATH, dirname(@__FILE__))
include("tasks.jl")

@pyimport neuroglancer.simple_task_queue.task_queue as task_queue
tq = task_queue.TaskQueue("http://50.16.149.198:8000/1.0")

using Save
counter=0
#map_chunks((10240:cx:(10240+54784-cx),7680:cy:(7680+36352-cy), 0:cz:1024-cz), 0, 1) do slices

#=
map_chunks((30000:cx:35000,20000:cy:25000, 0:cz:500), 0, 1) do slices
	global counter
	counter+=1
	println(counter)
	tq[:insert](name=string(slices),
	payload="""
	edge_task("s3://neuroglancer/pinky40_v11/watershed","gs://neuroglancer/pinky40_v11/mean_0.27_segmentation","s3://neuroglancer/pinky40_v11/chunked_regiongraph", $(slices))
	""")
end
=#

s=pl.Storage("s3://neuroglancer/pinky40_v11/chunked_regiongraph")
const edges = Set{Tuple{Label,Label}}()
const vertices = Set{Label}()
map_chunks((30000:cx:35000,20000:cy:25000, 0:cz:500), 0, 1) do slices
	content=s[:get_file](file_path="$(slices_to_str(slices))_edges.txt")
	x=eval(parse(content))
	for t in x
		push!(edges,t)
	end

	content=s[:get_file](file_path="$(slices_to_str(slices))_vertices.txt")
	x=eval(parse(content))
	for t in x
		push!(vertices,t)
	end
end
println(size(collect(edges)))

Save.save("~/testing/chunked_edges.jls",edges)
Save.save("~/testing/chunked_vertices.jls",vertices)
