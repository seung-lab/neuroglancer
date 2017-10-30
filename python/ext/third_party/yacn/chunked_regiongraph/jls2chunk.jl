push!(LOAD_PATH, dirname(@__FILE__))
include("../pre/Save.jl")
include("./constants.jl")

using ChunkedGraphs2
using Save
using Utils

G=ChunkedGraph("/ssd/testing2")
@time for f in filter(s->ismatch(r".*vertices.jls",s), readdir(expanduser("/ssd/testing2")))
	m=match(r"(\d+)_(\d+)_(\d+)_(\d+).*",f)
	id = chunk_id(map(x->parse(UInt32,x),m.captures)...)
	ChunkedGraphs2.save_chunk!(ChunkedGraphs2.get_chunk(G, id))
end
