push!(LOAD_PATH, dirname(@__FILE__))
println(LOAD_PATH)
using HttpServer
using HttpCommon
using ChunkedGraphs
using Save
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

function mesh!(v::ChunkedGraphs.Vertex)
	if !(v.label in meshed)
		if ChunkedGraphs.is_leaf(v)
			task=pl.ObjectMeshTask(slices_to_str(chunk_id_to_slices(v.label[2])),WATERSHED_STORAGE,[v.label[1]],v.label)
			println(task)
			task[:execute]()
		elseif length(v.children) > 0 && ChunkedGraphs.is_leaf(collect(v.children)[1])
			child1 = collect(v.children)[1]
			task = pl.ObjectMeshTask(slices_to_str(chunk_id_to_slices(child1.label[2])),WATERSHED_STORAGE,[child.label[1] for child in v.children],v.label)
			println(task)
			task[:execute]()
		else
			for child in v.children
				mesh!(child)
			end

			pl.MergeMeshTask(WATERSHED_STORAGE,[child.label for child in v.children],v.label)[:execute]()
		end
		push!(meshed,v.label)
	end
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
	   r"/1.0/node/(\d+)/?" => handle_node
	   )

headers=HttpCommon.headers()

headers["Access-Control-Allow-Origin"]= "*"
headers["Access-Control-Allow-Headers"]= "x-requested-with"
headers["Access-Control-Allow-Methods"]= "POST, GET, OPTIONS"
http = HttpHandler() do req::Request, res::Response
	for r in keys(d)
		if ismatch(r, req.resource)

			m = match(r"/1.0/node/(\d+)/?",req.resource)

			return d[r](m.captures...)
		end
	end
end
http.events["listen"] = (saddr) -> println("Running on https://$saddr (Press CTRL+C to quit)")

server = Server(http)

run(server, host=getaddrinfo("seungworkstation1000.princeton.edu"), port=9100)
