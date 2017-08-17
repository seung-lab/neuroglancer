push!(LOAD_PATH, dirname(@__FILE__))
include("../pre/Save.jl")
include("./constants.jl")
using ChunkedGraphs2
using Utils

function is_valid(x)
	return seg_id(x)!=0
end
function is_valid{T}(x::Tuple{T,T})
	return is_valid(x[1]) && is_valid(x[2])
end

edges = filter(is_valid, Save.load("~/data/chunked_edges.jls"))
vertices = filter(is_valid, Save.load("~/data/chunked_vertices.jls"))
sort!(edges)
sort!(vertices)
println(length(edges))
println(length(vertices))

N=10
function partition(A,N)
	step = round(Int,length(A)/N)
	@assert length(1:step:length(A))==N
	return [view(A,i:min(i+step,length(A))) for i in 1:step:length(A)]
end

G=ChunkedGraph("~/testing3")
for (current_vertices,current_edges) in collect(zip(partition(vertices,N), partition(edges,N)))
	current_vertices=sort!(convert(Vector{Utils.Label},unique(cat(1,current_vertices, Utils.Label[e[1] for e in current_edges], Utils.Label[e[2] for e in current_edges]))))
	@time add_atomic_vertices!(G,current_vertices)
	@time add_atomic_edges!(G,current_edges)
	@time update!(G)
end

ChunkedGraphs2.save!(G)
