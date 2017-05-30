push!(LOAD_PATH, dirname(@__FILE__))
using HttpServer
using HttpCommon
using ChunkedGraphs
using Save
using PyCall
using Utils

@pyimport neuroglancer.simple_task_queue.task_queue as task_queue
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
			ObjectMeshTask("$(slices_to_str(chunk_id_to_slices(chunk_id(child1.label),high_pad=1)))","$(WATERSHED_STORAGE)",$(simple_print([seg_id(child.label) for child in v.children])),$(seg_id(v.label))).execute()
			""")
		else
			task_name = string(task_labeller())
			child_task_names = filter(x->x!=nothing,[mesh!(child) for child in v.children])
			tq[:insert](name=task_name,
			payload="""
			MergeMeshTask("$(WATERSHED_STORAGE)",$(simple_print([seg_id(child.label) for child in v.children])),$(seg_id(v.label))).execute()
			""",
			dependencies=child_task_names)
		end
		mesh_task[v.label]=task_name
	end
	return mesh_task[v.label]
end

function handle_node(id)
	id=parse(UInt32,id)
	l=handles[id]

	root_vertex = bfs(G, handles[id])[1]
	segments = leaves(root_vertex)

	println("selected $(length(segments)) segments")
	s=cat(1,collect(Set{UInt32}(seg_id(x) for x in segments)),seg_id(root_vertex.label))
	mesh!(root_vertex)
	return Response(reinterpret(UInt8,s),headers)
end

function children(id)
	id=parse(UInt32,id)
	v=handles[id]
	s = UInt32[child.label for child in v.children]
	return Response(reinterpret(UInt8,s),headers)
end

function pos_to_label(x)
	x=eval(parse(x))
	return (x[1],to_chunk_id(x[2],x[3],x[4]))
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
