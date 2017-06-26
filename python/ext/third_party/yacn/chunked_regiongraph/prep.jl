push!(LOAD_PATH, dirname(@__FILE__))
include("tasks.jl")

@pyimport neuroglancer.simple_task_queue.task_queue as task_queue
tq = task_queue.TaskQueue("http://50.16.149.198:8000/1.0")

using Save
SLICES = (10240:cx:(10240+54784-cx-2),7680:cy:(7680+36352-cy-2), 0:cz:1000-cz-2)
TEST_SLICES = (mod(10240, cx) + cx*fld(20000,cx):cx:30000, mod(7680,cy) + cy*fld(30000,cy):cy:40000, 0:cz:512)

#=
counter=0
map_chunks(SLICES, 0, 1) do slices
	global counter
	counter+=1
	println(counter)
	tq[:insert](name=string(slices),
	payload="""
	edge_task("s3://neuroglancer/pinky40_v11/watershed","gs://neuroglancer/pinky40_v11/mean_0.27_segmentation","s3://neuroglancer/pinky40_v11/chunked_regiongraph", $(slices))
	""")
end
=#




#=
file_list = collect(Task(()->map_chunks(slices->begin produce("$(slices_to_str(slices))_edges.txt"); produce("$(slices_to_str(slices))_vertices.txt") end, SLICES, 0, 1)))
s=pl.Storage("s3://neuroglancer/pinky40_v11/chunked_regiongraph")
files = s[:get_files](file_list)

println("done downloading")

for f in files
	open("/tmp_ram/$(f["filename"])","w") do fhandle
		write(fhandle,f["content"])
	end
end
println("done")
=#





using Base.Threads
file_list = collect(Task(()->map_chunks(slices->produce(slices_to_str(slices)), TEST_SLICES, 0, 1)))
edges = Array{Tuple{Label,Label},1}[Tuple{Label,Label}[] for i in 1:length(file_list)]
vertices = Array{Label,1}[Label[] for i in 1:length(file_list)]
@threads for i in 1:length(file_list)
	open("/tmp_ram/$(file_list[i])_edges.txt") do f
		edges[i] = eval(parse(readstring(f)))
	end
	open("/tmp_ram/$(file_list[i])_vertices.txt") do f
		vertices[i] = eval(parse(readstring(f)))
	end
end
println("done")



println(typeof(vertices))
println(typeof(edges))
function unique_flatten{T}(As::Array{Array{T,1},1})
	ret = Set{T}()
	sizehint!(ret, sum(map(length, As)))
	for A in As
		for a in A
			push!(ret,a)
		end
	end
	return collect(ret)
end
vertices_final = unique_flatten(vertices)
edges_final = unique_flatten(edges)

println(size(vertices_final))
println(size(edges_final))

Save.save("~/testing/chunked_edges.jls",edges_final)
Save.save("~/testing/chunked_vertices.jls",vertices_final)
