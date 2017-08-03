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
println(length(edges))
println(length(vertices))


function partition(A,N)
	return [view(A,i:min(i+N,length(A))) for i in 1:N:length(A)]
end

N=round(Int,1e8)

#=
for current_edges in partition(edges,N)
	current_vertices=unique(cat(1,UInt64[e[1] for e in current_edges],UInt64[e[2] for e in current_edges]))

	G=ChunkedGraph("~/testing")
	@profile begin
		@time add_atomic_vertices!(G,current_vertices)
		@time add_atomic_edges!(G,current_edges)
		@time update!(G)
	end
	ChunkedGraphs2.save!(G)
end
=#

G=ChunkedGraph("~/testing")

for (i,v) in enumerate(setdiff(vertices,cat(1,UInt64[e[1] for e in edges],UInt64[e[2] for e in edges])))
	if i%1000 == 0
		println(i)
	end
	add_atomic_vertex!(G,v)
end
update!(G)
ChunkedGraphs2.save!(G)


Profile.init(n=10000000,delay=0.1)
@profile for i in 1:10
	println(i)
	@time begin
		v1=rand(vertices)
		v2=rand(vertices)
		add_atomic_vertex!(G,v1)
		add_atomic_vertex!(G,v2)
		update!(G)
		get_vertex(G,v1)
		get_vertex(G,v2)
		rand([add_atomic_edge!,delete_atomic_edge!])(G,(v1,v2))
		get_vertex(G,v1)
		get_vertex(G,v2)
		update!(G)
	end
end

using ProfileView
ProfileView.view()
wait()
