push!(LOAD_PATH, dirname(@__FILE__))
include("../pre/Save.jl")
include("./constants.jl")
using ChunkedGraphs2
using Utils
using JSON

rel(p::String) = joinpath(dirname(@__FILE__), p)

settings = JSON.parsefile(rel("server.conf"))

function is_valid(x)
	return seg_id(x)!=0
end
function is_valid{T}(x::Tuple{T,T})
	return is_valid(x[1]) && is_valid(x[2])
end

println("Loading edges...")
edges = Save.load(joinpath(rel(settings["graphpath"]), "chunked_edges.jls"))
println("Loading vertices...")
vertices = Save.load(joinpath(rel(settings["graphpath"]), "chunked_vertices.jls"))

println(length(edges))
println(length(vertices))

N=5
function partition(A,N)
	step = ceil(Int,length(A)/N)
	@assert length(1:step:length(A))==N
	return [view(A,i:min(i+step,length(A))) for i in 1:step:length(A)]
end

partitioned = collect(zip(partition(vertices,N), partition(edges,N)))
edges = nothing
vertices = nothing
G=ChunkedGraph(rel(settings["graphpath"]))
gc()
for (current_vertices,current_edges) in partitioned
	@time current_vertices=sort!(convert(Vector{Utils.Label},unique(vcat(current_vertices, Utils.Label[e[1] for e in current_edges], Utils.Label[e[2] for e in current_edges]))))
	@time add_atomic_vertices!(G,current_vertices)
	@time add_atomic_edges!(G, map(x->Utils.AtomicEdge(x), current_edges))
	@time update!(G)
end

ChunkedGraphs2.save!(G)
