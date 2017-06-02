push!(LOAD_PATH, dirname(@__FILE__))
using HttpServer
using HttpCommon
using ChunkedGraphs
using Save
using PyCall

@pyimport neuroglancer.simple_task_queue.task_queue as task_queue
tq = task_queue.TaskQueue("http://localhost:8006/1.0")

include("tasks.jl")

edges = Save.load("~/testing/chunked_edges.jls")
vertices = collect(Set(cat(1,[x[1] for x in edges],[x[2] for x in edges])))
println(length(edges))
println(length(vertices))
handles = Dict()
mesh_label = Dict()
for v in vertices
	handles[v[1]]=v
end

G=ChunkedGraph()
for v in vertices
	add_atomic_vertex!(G,v)
end

for e in edges
	add_atomic_edge!(G,e)
end
update!(G.root)
const WATERSHED_STORAGE = "s3://neuroglancer/pinky40_v11/watershed"

const meshed=Set()

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

function mesh!(v::ChunkedGraphs.Vertex)
	if !(v.label in meshed)
		#if ChunkedGraphs.is_leaf(v)
		if ChunkedGraphs.level(v)==0
			task_name=string(task_labeller())
			tq[:insert](name=task_labeller(),
			 payload="""
			 ObjectMeshTask("$(slices_to_str(chunk_id_to_slices(v.label[2])))","$(WATERSHED_STORAGE)",$(simple_print([v.label[1]])),$(v.label)).execute()
			 """)
		#elseif length(v.children) > 0 && ChunkedGraphs.is_leaf(collect(v.children)[1])
		elseif ChunkedGraphs.level(v)==1
			child1 = collect(v.children)[1]
			task_name=string(task_labeller())
			tq[:insert](name=task_name,
			payload="""
			ObjectMeshTask("$(slices_to_str(chunk_id_to_slices(child1.label[2])))","$(WATERSHED_STORAGE)",$(simple_print([child.label[1] for child in v.children])),$(v.label)).execute()
			""")
			println(task_name)
		else
			task_name = string(task_labeller())
			child_task_names = filter(x->x!=nothing,[mesh!(child) for child in v.children])
			tq[:insert](name=task_name,
			payload="""
			MergeMeshTask("$(WATERSHED_STORAGE)",$([child.label for child in v.children]),$(v.label)).execute()
			""",
			dependencies=child_task_names)
		end
		push!(meshed,v.label)
		return task_name
	end
	return nothing
end

function handle_node(id)
	id=parse(UInt32,id)
	root_vertex = bfs(G, handles[id])[1]
	segments = leaves(root_vertex)
	println(segments)
	s=cat(1,collect(Set{UInt32}(x[1] for x in segments)),UInt32[root_vertex.label])
	mesh!(root_vertex)
	return Response(reinterpret(UInt8,s),headers)

end

d=Dict(
	   r"/1.0/node/(\d+)/?" => handle_node,
	   r"/1.0/split/(\d+),(\d+),(\d+),(\d+)_(\d+),(\d+),(\d+),(\d+)/?" => split,
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
end
http.events["listen"] = (saddr) -> println("Running on https://$saddr (Press CTRL+C to quit)")

server = Server(http)

run(server, host=getaddrinfo("seungworkstation1000.princeton.edu"), port=9100)
