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


@pyimport neuroglancer.pipeline.task_queue as task_queue
@pyimport neuroglancer.pipeline.tasks as tasks 
tq = task_queue.TaskQueue(queue_server="pull-queue",n_threads=0)
#tq = task_queue.TaskQueue(queue_server="appengine",n_threads=0)

#@pyimport neuroglancer.simple_task_queue.task_queue as task_queue
#tq = task_queue.TaskQueue("http://127.0.0.1:8000/1.0")

G=ChunkedGraph("~/testing2")
const WATERSHED_STORAGE = "gs://neuroglancer/pinky40_v11/watershed"

#println(chunk_id_to_slices(ChunkID(map(UInt32,(1,42,42,2))...)))
#wait()

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
	if ChunkedGraphs2.level(c) == 1 && false
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
							 slices_to_str(chunk_id_to_slices(c.id,high_pad=0)),
							 WATERSHED_STORAGE, 
							 remap=remap,
							 generate_manifests=true
							 )
		tq[:insert](task)
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
@time for f in filter(s->ismatch(r".*vertices.jls",s), readdir(expanduser("~/testing2")))
	m=match(r"(\d+)_(\d+)_(\d+)_(\d+).*",f)
	id = ChunkID(map(x->parse(UInt32,x),m.captures)...)
	if Utils.level(id) == 1
		mesh!(ChunkedGraphs2.get_chunk(G,id))
	end
end
#mesh!(ChunkedGraphs2.get_chunk(G,ChunkedGraphs2.TOP_ID))
tq[:wait]()
