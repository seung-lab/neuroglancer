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
using JSON

rel(p::String) = joinpath(dirname(@__FILE__), p)

settings = JSON.parsefile(rel("server.conf"))

@pyimport neuroglancer.pipeline.task_queue as task_queue
@pyimport neuroglancer.pipeline.tasks as tasks 
tq = task_queue.TaskQueue(queue_server="pull-queue",n_threads=0)
#tq = task_queue.TaskQueue(queue_server="appengine",n_threads=0)

#@pyimport neuroglancer.simple_task_queue.task_queue as task_queue
#tq = task_queue.TaskQueue("http://127.0.0.1:8000/1.0")

G = ChunkedGraph(rel(settings["graphpath"]))
const WATERSHED_STORAGE = "gs://neuroglancer/pinky40_v11/watershed"

function labeller(start_label)
	n=start_label
	function unique_label()
		n=n+1
		return n
	end
	return unique_label
end

task_labeller = labeller(0)
function mesh!(c::ChunkedGraphs2.Chunk)
	if ChunkedGraphs2.level(c) == 1 #&& false
		vertex_list=Set()
		if length(c.vertices) == 0
			return nothing
		end
		for v in values(c.vertices)
			if v.parent != ChunkedGraphs2.NULL_LABEL
				push!(vertex_list,get_vertex(G,v.parent))
			end
		end

		remap=Dict()
		for v in vertex_list
			for l in leaves(G,v)
				remap[seg_id(l)]=v.label
			end
		end

		label=task_labeller()
		task = tasks.MeshTask(
							 "4_4_40",
							 slices_to_str(chunk_id_to_slices(c.id)),
							 WATERSHED_STORAGE, 
							 remap=remap,
							 generate_manifests=true,
                                                         low_pad=0,
                                                         high_pad=1,
                                                         simplification_factor=100000,
                                                         max_simplification_error=70
							 )
		tq[:insert](task)
                println(slices_to_str(chunk_id_to_slices(c.id)))
		return label
	elseif ChunkedGraphs2.level(c) >= 2
		#deps = filter(x-> x!=nothing, [mesh!(child) for child in c.subgraphs])

		vertex_list=Set()
		for v in values(c.vertices)
			if v.parent != ChunkedGraphs2.NULL_LABEL
				push!(vertex_list,get_vertex(G,v.parent))
			end
		end

		remap=Dict()
		for v in vertex_list
			for l in v.children
				remap[seg_id(l)]=v.label
			end
		end

		label=task_labeller()
		task = tasks.MergeMeshTask(WATERSHED_STORAGE, remap)
		tq[:insert](task)
		return label
		return nothing
	else
		return nothing
	end
end
#@time for f in filter(s->ismatch(r".*\.chunk",s), readdir(expanduser(rel(settings["graphpath"]))))
#	m=match(r"(\d+)_(\d+)_(\d+)_(\d+)\..*",f)
#	id = chunk_id(map(x->parse(UInt32,x),m.captures)...)
#	x,y,z = pos(id)
#        if level(id) == 1 && x == 0x51 && y == 0x39 && (z == 0x02 || z == 0x03) #if Utils.level(id) == 1
#		mesh!(ChunkedGraphs2.get_chunk(G,id))
#	end
#end

r = get_vertex(G, 0x09000000000118da)
agg3 = [r.label] #leaves(G, r, 8)
for (idx, lbl) in enumerate(agg3)
	v = get_vertex(G, lbl)

	task = tasks.MeshStitchTask(
		WATERSHED_STORAGE, 
		#map(x->"$(x):0:$(slices_to_str(chunk_id_to_slices(chunk_id(x))))", v.children),
		map(x->"$(x):0", v.children),
		"$(v.label):0:$(slices_to_str(chunk_id_to_slices(chunk_id(v.label))))",
		simplification_factor = 10000,
		max_simplification_error = 8960
	)
	println("$idx / $(length(agg3)): $(v.label):0:$(slices_to_str(chunk_id_to_slices(chunk_id(v.label))))")
	tq[:insert](task)
end

tq[:wait]()
