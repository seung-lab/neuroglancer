push!(LOAD_PATH, dirname(@__FILE__))
include("../pre/Save.jl")
include("./constants.jl")
using MbedTLS
using HttpServer
using HttpCommon
using ChunkedGraphs2
using Save
using PyCall
using Utils

# Generate a certificate and key if they do not exist
rel(p::String) = joinpath(dirname(@__FILE__), p)
if !isfile(rel("keys/server.crt"))
	@static if is_unix()
		run(`mkdir -p $(rel("keys"))`)
		run(`openssl req -x509 -nodes -days 365 -newkey rsa:2048 -keyout
			$(rel("keys/server.key")) -out $(rel("keys/server.crt"))`)
	end
end

@pyimport neuroglancer.simple_task_queue.task_queue as task_queue
tq = task_queue.TaskQueue("http://127.0.0.1:8000/1.0")

edges = Save.load("~/data/chunked_edges.jls")
vertices = Save.load("~/data/chunked_vertices.jls")

#N=round(Int,1e8)
#edges=edges[1:N]
#vertices=unique(cat(1,UInt64[e[1] for e in edges],UInt64[e[2] for e in edges]))

println("$(length(edges)) edges")
println("$(length(vertices)) vertices")

function get_handles(vertices)
		handles = Dict{UInt32,UInt64}()
		for v in vertices
				handles[seg_id(v)]=v
		end
		return handles
end

@time handles = get_handles(vertices)
G=ChunkedGraph("~/testing")

const WATERSHED_STORAGE = "gs://neuroglancer/pinky40_v11/watershed_cutout"

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

function mesh!(c::ChunkedGraphs2.Chunk)
	if ChunkedGraphs2.level(c) == 1
		vertex_list = unique(map(ChunkedGraphs2.parent,get_vertices(c)))

		mesh_task_name = string(task_labeller())
		tq[:insert](name=mesh_task_name,
		payload=prod(["""
		ObjectMeshTask("$(slices_to_str(chunk_id_to_slices(c.id,high_pad=0)))","$(WATERSHED_STORAGE)",$(simple_print([seg_id(child.label) for child in v.children])),$(v.label)).execute()
		""" for v in vertex_list]))

		task_name = string(task_labeller())
		tq[:insert](name=task_name,
		payload=prod(["""
		MergeMeshTask("$(WATERSHED_STORAGE)",$(simple_print([v.label])),$(v.label)).execute()
		""" for v in vertex_list]),
		dependencies = [mesh_task_name])
	else
		for child in c.subgraphs
			mesh!(child)
		end
	end
	return
end

function mesh!(v::ChunkedGraphs2.Vertex)
	if !haskey(mesh_task,v.label)
		if ChunkedGraphs2.level(v)==2 && length(v.children) >= 1
			child1 = collect(v.children)[1]
			task_name=string(task_labeller())
			tq[:insert](name=task_name,
			payload="""
			ObjectMeshTask("$(slices_to_str(chunk_id_to_slices(chunk_id(child1.label),high_pad=0)))","$(WATERSHED_STORAGE)",$(simple_print([seg_id(child.label) for child in v.children])),$(v.label)).execute()
			""")
		else
			task_name = string(task_labeller())
			child_task_names = filter(x->x!=nothing,[mesh!(child) for child in v.children])
			tq[:insert](name=task_name,
			payload="""
			MergeMeshTask("$(WATERSHED_STORAGE)",$(simple_print([child.label for child in v.children])),$(v.label)).execute()
			""",
			dependencies=child_task_names)
			println("Level $(ChunkedGraphs2.level(v)) Manifest: $(task_name), Segments: $(simple_print([child.label for child in v.children]))")
		end
		mesh_task[v.label]=task_name
	end
	return mesh_task[v.label]
end

function handle_remesh(id)
	id=parse(UInt64,id)

	if chunk_id(id) == 0 # Lvl 0, a neuroglancer supervoxel, need to lookup chunk id
		id=handles[id]
	end

	v = get_vertex(G, id)

	println("Remeshing $(v.label) and all descendants.")
	mesh!(v)

	return Response(reinterpret(UInt8,[v.label]),headers)
end

function handle_leaves(id)
	id=parse(UInt64,id)

	if chunk_id(id) == 0 # Lvl 0, a neuroglancer supervoxel, need to lookup chunk id
		id=handles[id]
	end

	root_vertex = bfs(G, id)[1]
	segments = leaves(G,root_vertex)

	println("$(now()): selected $(length(segments)) segments with root $(root_vertex.label)")
	s=cat(1,collect(Set{UInt64}(seg_id(x) for x in segments)),root_vertex.label)

	return Response(reinterpret(UInt8,s),headers)
end

function handle_root(id)
	id=parse(UInt64,id)
	print("$(now()): Root for segment $(id): ")

	if chunk_id(id) == 0 # Lvl 0, a neuroglancer supervoxel, need to lookup chunk id
		id=handles[id]
	end

	root_vertex = bfs(G, id)[1]
	#mesh!(root_vertex)
	println("$(root_vertex.label)")

	return Response(reinterpret(UInt8,[root_vertex.label]),headers)
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
	if ChunkedGraphs2.level(v) == 2 # Lvl 2, children are neuroglancer supervoxel, need to trim the chunk ids
		#return Response(UInt8[],headers)
		s = UInt64[seg_id(child) for child in v.children]
		println("$(now()): handle_children - v: $(v.label), (Level $(ChunkedGraphs2.level(v))), - children: $(simple_print([seg_id(child) for child in v.children]))")
	else
		s = UInt64[child for child in v.children]
		println("$(now()): handle_children - v: $(v.label), (Level $(ChunkedGraphs2.level(v))), - children: $(simple_print([child for child in v.children]))")
	end

	return Response(reinterpret(UInt8,s),headers)
end

function handle_split(id1,id2)
	id1 = parse(UInt64, id1)
	if chunk_id(id1) == 0 # Lvl 0, a neuroglancer supervoxel, need to lookup chunk id
		id1 = handles[id1]
	end

	id2 = parse(UInt64, id2)
	if chunk_id(id2) == 0 # Lvl 0, a neuroglancer supervoxel, need to lookup chunk id
		id2 = handles[id2]
	end

	delete_atomic_edge!(G, (id1, id2))
	update!(G)

	root1 = bfs(G, id1)[1]
	root2 = bfs(G, id2)[1]
	println("$(now()): Split $(seg_id(id1)) and $(seg_id(id2)) => $(root1.label), $(root2.label)")

	return Response(reinterpret(UInt8, [root1.label, root2.label]), headers)
end

function handle_merge(id1, id2)
	id1 = parse(UInt64, id1)
	if chunk_id(id1) == 0 # Lvl 0, a neuroglancer supervoxel, need to lookup chunk id
		id1 = handles[id1]
	end

	id2 = parse(UInt64, id2)
	if chunk_id(id2) == 0 # Lvl 0, a neuroglancer supervoxel, need to lookup chunk id
		id2 = handles[id2]
	end

	add_atomic_edge!(G, (id1, id2))
	update!(G)

	root = bfs(G, id1)[1]
	println("$(now()): Merged $(seg_id(id1)) and $(seg_id(id2)) => $(root.label)")
	
	return Response(reinterpret(UInt8, [root.label]), headers)
end

function handle_subgraph(vertices)
	return Response(simple_print(MultiGraphs.induced_edges(G, eval(parse(vertices)))))
end

d=Dict(
		 r"/1.0/segment/(\d+)/root/?" => handle_root,
		 r"/1.0/segment/(\d+)/children/?" => handle_children,
		 r"/1.0/segment/(\d+)/leaves/?" => handle_leaves,
		 r"/1.0/segment/(\d+)/remesh/?" => handle_remesh, # TODO: POST
		 r"/1.0/merge/(\d+),(\d+)/?" => handle_merge, # TODO: POST
		 r"/1.0/split/(\d+),(\d+)/?" => handle_split, # TODO: POST
		 r"/1.0/subgraph/(\[[\d,\(\)]*?\])/?" => handle_subgraph,
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
cert = MbedTLS.crt_parse_file(rel("keys/server.crt"))
key = MbedTLS.parse_keyfile(rel("keys/server.key"))

run(server, host=getaddrinfo("seungworkstation1000.princeton.edu"), port=9100, ssl=(cert, key))
