push!(LOAD_PATH, dirname(@__FILE__))
include("../pre/Save.jl")
include("./constants.jl")

using MbedTLS
using HttpServer
using HttpCommon
using ChunkedGraphs2
using Save
#using PyCall
using Utils
using Logging
using JSON

rel(p::String) = joinpath(dirname(@__FILE__), p)

settings = JSON.parsefile(rel("server.conf"))
@static if is_unix()
	run(`mkdir -p $(rel(settings["graphpath"]))`)
  run(`mkdir -p $(rel(settings["logpath"]))`)
  run(`mkdir -p $(rel(settings["certpath"]))`)
end

@Logging.configure(level=DEBUG)
Logging.configure(filename=joinpath(rel(settings["logpath"]), "graph.log"))


# Generate a certificate and key if they do not exist
if !isfile(joinpath(rel(settings["certpath"]), "server.crt"))
	@static if is_unix()
		run(`openssl req -x509 -nodes -days 365 -newkey rsa:2048 -keyout
			$(joinpath(rel(settings["certpath"]), "server.key")) -out $(joinpath(rel(settings["certpath"]), "server.crt"))`)
	end
end

#=
@pyimport neuroglancer.pipeline.task_queue as task_queue
@pyimport neuroglancer.pipeline.tasks as tasks 
tq = task_queue.TaskQueue(queue_server="pull-queue")
=#

G = ChunkedGraph(rel(settings["graphpath"]))
@time for f in filter(s->ismatch(r".*\.chunk",s), readdir(expanduser(rel(settings["graphpath"]))))
	m=match(r"(\d+)_(\d+)_(\d+)_(\d+)\..*",f)
	id = ChunkID(map(x->parse(UInt32,x),m.captures)...)
	if Utils.level(id) >= 3
		ChunkedGraphs2.get_chunk(G,id)
	end
end

#edges = Save.load(joinpath(rel(settings["graphpath"]), "chunked_edges.jls"))
vertices = Vector{UInt64}()
if(length(G.graphs) > 0)
  vertices = Save.load(joinpath(rel(settings["graphpath"]), "chunked_vertices.jls"))
end

#println("$(length(edges)) edges")
println("$(length(vertices)) vertices")

function get_handles(vertices)
		handles = Dict{UInt32,UInt64}()
		for v in vertices
				handles[seg_id(v)]=v
		end
		return handles
end


@time handles = get_handles(vertices)


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
		vertex_list=Set()
		for v in values(c.vertices)
			if v.parent != ChunkedGraphs2.NULL_LABEL
				push!(vertex_list,get_vertex(G,v.parent))
			end
		end

		d=Dict()
		for v in vertex_list
			for l in leaves(G,v)
				d[seg_id(l)]=v.label
			end
		end

		mesh_task_name = string(task_labeller())
		task = tasks.MeshTask(
							 "4_4_40",
							 slices_to_str(chunk_id_to_slices(c.id,high_pad=0)),
							 WATERSHED_STORAGE, 
							 remap=d
							 )
		tq[:insert](task)
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
  @debug("handle_remesh($id)")
	id=parse(UInt64,id)

	if chunk_id(id) == 0 # Lvl 1, a neuroglancer supervoxel, need to lookup chunk id
		id=handles[id]
	end

	v = get_vertex(G, id)

	println("Remeshing $(v.label) and all descendants.")
	mesh!(v)

	return Response(reinterpret(UInt8,[v.label]),headers)
end

function handle_leaves(id)
  @debug("handle_leaves($id)")
	id=parse(UInt64,id)

	if chunk_id(id) == 0 # Lvl 1, a neuroglancer supervoxel, need to lookup chunk id
		id=handles[id]
	end

	root_vertex = bfs(G, id)[1]
	segments = leaves(G,root_vertex)

	println("$(now()): selected $(length(segments)) segments with root $(root_vertex.label)")
	s=cat(1,collect(Set{UInt64}(seg_id(x) for x in segments)),root_vertex.label)

	return Response(reinterpret(UInt8,s),headers)
end

function handle_root(id)
  @debug("handle_root($id)")
	id=parse(UInt64,id)
	print("$(now()): Root for segment $(id): ")

	if chunk_id(id) == 0 # Lvl 1, a neuroglancer supervoxel, need to lookup chunk id
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
  @debug("handle_children($id)")
	id = parse(UInt64,id)

	if chunk_id(id) == 0 # Lvl 1, a neuroglancer supervoxel, need to lookup chunk id
		id = handles[id]
	end

	v = get_vertex(G, id)

	if ChunkedGraphs2.level(v) == 1 # Lvl 1, a neuroglancer supervoxel, no children
		s = UInt64[]
		println("$(now()): handle_children - v: $(v.label), (Level $(ChunkedGraphs2.level(v)))")
	elseif ChunkedGraphs2.level(v) == 2 # Lvl 2, children are neuroglancer supervoxel, need to trim the chunk ids
		s = UInt64[seg_id(child) for child in v.children]
		println("$(now()): handle_children - v: $(v.label), (Level $(ChunkedGraphs2.level(v))), - children: $(simple_print([seg_id(child) for child in v.children]))")
	else
		#s = UInt64[child for child in v.children]
		s = UInt64[child for child in leaves(G,v,2)] # J's hack to skip the middle layers and jump right to the pre-meshed lower level agglomeration.
		println("$(now()): handle_children - v: $(v.label), (Level $(ChunkedGraphs2.level(v))), - children: $(simple_print([child for child in v.children]))")
	end

	return Response(reinterpret(UInt8,s),headers)
end

function handle_split(id1,id2)
  @info("handle_split($id1, $id2)")
	id1 = parse(UInt64, id1)
	@assert chunk_id(id1)==0
	if chunk_id(id1) == 0 # Lvl 1, a neuroglancer supervoxel, need to lookup chunk id
		id1 = handles[id1]
	end

	id2 = parse(UInt64, id2)
	@assert chunk_id(id2)==0
	if chunk_id(id2) == 0 # Lvl 1, a neuroglancer supervoxel, need to lookup chunk id
		id2 = handles[id2]
	end

	#delete_atomic_edge!(G, (id1, id2))
	cuts = ChunkedGraphs2.min_cut(G,id1,id2)
	for e in cuts
		delete_atomic_edge!(G,e)
	end
	update!(G)

	root_labels = Set{UInt64}()
	for e in cuts
		push!(root_labels, bfs(G, e[1])[1].label)
		push!(root_labels, bfs(G, e[2])[1].label)
	end

	root_labels = Array{UInt64}(map(x->level(chunk_id(x)) == 1 ? seg_id(x) : x, collect(root_labels)))

	println("$(now()): Split $(seg_id(id1)) and $(seg_id(id2)) => $(simple_print(root_labels))")
	return Response(reinterpret(UInt8, root_labels), headers)
end

function handle_merge(id1, id2)
  @info("handle_merge($id1, $id2)")
	id1 = parse(UInt64, id1)
	@assert chunk_id(id1)==0
	if chunk_id(id1) == 0 # Lvl 1, a neuroglancer supervoxel, need to lookup chunk id
		id1 = handles[id1]
	end

	id2 = parse(UInt64, id2)
	@assert chunk_id(id2)==0
	if chunk_id(id2) == 0 # Lvl 1, a neuroglancer supervoxel, need to lookup chunk id
		id2 = handles[id2]
	end

	add_atomic_edge!(G, (id1, id2))
	update!(G)

	root = bfs(G, id1)[1]
	println("$(now()): Merged $(seg_id(id1)) and $(seg_id(id2)) => $(root.label)")
	
	return Response(reinterpret(UInt8, [root.label]), headers)
end

function handle_subgraph(vertices)
  @debug("handle_subgraph($vertices)")
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

cert = MbedTLS.crt_parse_file(joinpath(rel(settings["certpath"]), "server.crt"))
key = MbedTLS.parse_keyfile(joinpath(rel(settings["certpath"]), "server.key"))

run(server, host=getaddrinfo(settings["host"]), port=settings["port"], ssl=(cert, key))
