push!(LOAD_PATH, dirname(@__FILE__))
include("../pre/Save.jl")
using HttpServer
using HttpCommon
using ChunkedGraphs
using Save
using PyCall
using Utils

# type MeshNode
# 	min::Vector{Int32}
# 	max::Vector{Int32}
# 	paths::Vector{String}
# 	alternatives::Vector{MeshNode}
# 	function MeshNode()
# 		return new([-1,-1,-1], [-1,-1,-1], [], [])
# 	end
# end


@pyimport neuroglancer.simple_task_queue.task_queue as task_queue
#tq = task_queue.TaskQueue("http://127.0.0.1:8000/1.0")
tq = task_queue.TaskQueue("http://50.16.149.198:8001/1.0")

edges = Save.load("~/testing/chunked_edges.jls")
vertices = Save.load("~/testing/chunked_vertices.jls")
println("$(length(edges)) edges")
println("$(length(vertices)) vertices")
handles = Dict()
mesh_label = Dict()
for v in vertices
	handles[seg_id(v)]=v
end

begin
	G=ChunkedGraph()
	for v in vertices
		add_atomic_vertex!(G,v)
	end

	for e in edges
		add_atomic_edge!(G,e)
	end
	@time update!(G)
end
#=
Profile.init(n=Int(1e7),delay=0.01)
@profile begin
	G=ChunkedGraph()
	for v in vertices
		add_atomic_vertex!(G,v)
	end

	for e in edges
		add_atomic_edge!(G,e)
	end
	@time update!(G)
end
using ProfileView
ProfileView.view()
wait()
=#

const WATERSHED_STORAGE = "s3://neuroglancer/pinky40_v11/watershed"

#maps ids to the mesh task name
const mesh_task=Dict()

function labeller(start_label)
	n=start_label
	function unique_label()
		n=n+1
		return n
	end
	return unique_label
end

task_labeller = labeller(0)

function simple_print(x::Array)
	string('[',map(n->"$(n),",x)...,']')
end

function mesh!(c::ChunkedGraphs.Chunk)
	vertex_list = vertices(c)
	if !haskey(mesh_task,v.label)
		if ChunkedGraphs.level(v)==2
			task_name=string(task_labeller())
			tq[:insert](name=task_name,
			payload=prod(["""
			ObjectMeshTask("$(slices_to_str(chunk_id_to_slices(c.id),high_pad=1))","$(WATERSHED_STORAGE)",$(simple_print([child.label[1] for child in v.children])),$(v.label)).execute()
			""" for v in vertices(c)]))
		else
			task_name = string(task_labeller())
			child_task_names = filter(x->x!=nothing,[mesh!(child) for child in c.children])
			tq[:insert](name=task_name,
			payload=prod(["""
			MergeMeshTask("$(WATERSHED_STORAGE)",$([child.label for child in v.children]),$(v.label)).execute()
			"""
			for v in vertices(c)]),
			dependencies=child_task_names)
		end
		mesh_task[c.id]=task_name
		for v in vertex_list
			mesh_task[v.label] = task_name
		end
	end
	return mesh_task[c.id]
end

function mesh!(v::ChunkedGraphs.Vertex)
	if !haskey(mesh_task,v.label)
		if ChunkedGraphs.level(v)==2 && length(v.children) >= 1
			child1 = collect(v.children)[1]
			task_name=string(task_labeller())
			tq[:insert](name=task_name,
			payload="""
			ObjectMeshTask("$(slices_to_str(chunk_id_to_slices(chunk_id(child1.label),high_pad=1)))","$(WATERSHED_STORAGE)",$(simple_print([seg_id(child.label) for child in v.children])),$(v.label)).execute()
			""")
		else
			task_name = string(task_labeller())
			child_task_names = filter(x->x!=nothing,[mesh!(child) for child in v.children])
			tq[:insert](name=task_name,
			payload="""
			MergeMeshTask("$(WATERSHED_STORAGE)",$(simple_print([child.label for child in v.children])),$(v.label)).execute()
			""",
			dependencies=child_task_names)
			println("Level $(ChunkedGraphs.level(v)) Manifest: $(task_name), Segments: $(simple_print([child.label for child in v.children]))")
		end
		mesh_task[v.label]=task_name
	end
	return mesh_task[v.label]
end


# function mesh2!(v::ChunkedGraphs.Vertex, mesh_node::MeshNode)
# 	if ChunkedGraphs.level(v) == 0
# 		# A pre-meshed supervoxel within this lowest-resolution chunk; no alternatives
# 		chunk_pos = v.label[2]
# 		push!(mesh_node.paths, "$(v.label[1]):0:$(slices_to_str(chunk_id_to_slices(chunk_pos)))")
# 		return
# 	end
# 	if ChunkedGraphs.level(v) == 1
# 		# A fusion of all supervoxels within this lowest-resolution chunk
# 		child_node = MeshNode()
# 		for child in v.children
# 			mesh2!(child, child_node)
# 		end
# 		push!(mesh_node.alternatives, child_node)

# 		chunk_pos = collect(v.children)[1].label[2]
# 		chunk_slices = chunk_id_to_slices(chunk_pos)
# 		push!(mesh_node.paths, "$(v.label[1]):0:$(slices_to_str(chunk_slices))")

# 		for dim in 1:3
# 			mesh_node.min[dim], mesh_node.max[dim] = extrema(chunk_slices[dim])
# 			child_node.min[dim], child_node.max[dim] = mesh_node.min[dim], mesh_node.max[dim]
# 		end
# 	else
# 		for child in v.children
# 			child_node = MeshNode()
# 			mesh2!(child, child_node)
# 			push!(mesh_node.alternatives, child_node)
# 		end

# 		mesh_node.min = min(collect(x.min for x in mesh_node.alternatives)..., typemax(Int32))
# 		mesh_node.max = max(collect(x.max for x in mesh_node.alternatives)..., typemin(Int32))
# 		push!(mesh_node.paths, "$(v.label[1]):0:$(mesh_node.min[1])-$(mesh_node.max[1])_$(mesh_node.min[2])-$(mesh_node.max[2])_$(mesh_node.min[3])-$(mesh_node.max[3])")
# 	end
# end

function handle_node(id)
	id=parse(UInt64,id)

	if chunk_id(id) == 0 # Lvl 0, a neuroglancer supervoxel, need to lookup chunk id
		id=handles[id]
	end

	root_vertex = bfs(G, id)[1]
	segments = leaves(root_vertex)

	println("selected $(length(segments)) segments with root $(root_vertex.label)")
	s=cat(1,collect(Set{UInt64}(seg_id(x) for x in segments)),root_vertex.label)
	mesh!(root_vertex)

	return Response(reinterpret(UInt8,s),headers)
end

function pos_to_label(x)
	x=eval(parse(x))
	return (x[1],to_chunk_id(x[2],x[3],x[4]))
end

function handle_children(id)
	id = parse(UInt64,id)

	if chunk_id(id) == 0 # Lvl 0, a neuroglancer supervoxel, has no children
		return Response(UInt8[],headers)
	end

	v = get_vertex(G, id)
	if ChunkedGraphs.level(v) == 2 # Lvl 2, children are neuroglancer supervoxel, need to trim the chunk ids
		s = UInt64[seg_id(child.label) for child in v.children]
	else
		s = UInt64[child.label for child in v.children]
	end

	return Response(reinterpret(UInt8,s),headers)
end

function handle_split(id1,id2)
	delete_atomic_edge!(G, (parse(UInt64,id1), parse(UInt64,id2)))
	update!(G)
	return Response(UInt8[],headers)
end

function handle_merge(id1,id2)
	add_atomic_edge!(G, (parse(UInt64,id1), parse(UInt64,id2)))
	update!(G)
	return Response(UInt8[],headers)
end

function handle_subgraph(vertices)
	return Response(simple_print(MultiGraphs.induced_edges(G, eval(parse(vertices)))))
end

d=Dict(
		 r"/1.0/node/(\d+)/?" => handle_node,
		 r"/1.0/merge/(\d+),(\d+)/?" => handle_merge,
		 r"/1.0/split/(\d+),(\d+)/?" => handle_split,
		 r"/1.0/subgraph/(\[[\d,\(\)]*?\])/?" => handle_subgraph,
		 r"/1.0/children/(\d+)/?" => handle_children,
		 )

headers=HttpCommon.headers()

headers["Access-Control-Allow-Origin"]= "*"
headers["Access-Control-Allow-Headers"]= "x-requested-with"
headers["Access-Control-Allow-Methods"]= "POST, GET, OPTIONS"
http = HttpHandler() do req::Request, res::Response
	for r in keys(d)
		if ismatch(r, req.resource)
			m = match(r,req.resource)
			return d[r](m.captures...)
		end
	end
	println("could not parse $(req.resource)")
	return Response(400)
end
http.events["listen"] = (saddr) -> println("Running on https://$saddr (Press CTRL+C to quit)")

server = Server(http)

run(server, host=getaddrinfo("seungworkstation1000.princeton.edu"), port=9100)
#run(server, host=getaddrinfo("127.0.0.1"), port=9100)

