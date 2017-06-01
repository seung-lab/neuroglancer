include("tasks.jl")

using Save
map_chunks((30000:cx:31000,30000:cy:31000, 100:cz:200), 2, 2) do slices
	edge_task("s3://neuroglancer/pinky40_v11/watershed","gs://neuroglancer/pinky40_v11/mean_0.27_segmentation","s3://neuroglancer/pinky40_v11/chunked_regiongraph", slices)
end

s=pl.Storage("s3://neuroglancer/pinky40_v11/chunked_regiongraph")
const edges = Set{Tuple{Tuple{UInt32,Tuple{Int32,Int32,Int32,Int32}},
				  Tuple{UInt32,Tuple{Int32,Int32,Int32,Int32}},
				  }}()
map_chunks((30000:cx:31000,30000:cy:31000, 100:cz:200), 2, 2) do slices
	content=s[:get_file](file_path="$(slices_to_str(slices)).txt")
	x=eval(parse(content))
	for t in x
		push!(edges,t)
	end
end
println(size(collect(edges)))

Save.save("~/testing/chunked_edges.jls",edges)
