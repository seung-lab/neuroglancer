import DataStructures
using Save
include("MultiGraphs.jl")
import MultiGraphs

const Int=Int32

const cx = 512
const cy = 512
const cz = 64

const bx = 2
const by = 2
const bz = 2

@inline function int_div(x,y)
	return floor(Int,x/y)
end
@inline function to_chunk_id(x,y,z)
	return (Int(0), int_div(x,cx), int_div(y,cy), int_div(z,cz))
end

function chunked_labelling{T}(raw::Array{T,3})
	ret = Array{Tuple{T,Tuple{Int,Int,Int,Int}}}(size(raw))
	for k in 1:size(raw,3)
		for j in 1:size(raw,2)
			for i in 1:size(raw,1)
				ret[i,j,k]=(raw[i,j,k],to_chunk_id(i,j,k))
			end
		end
	end
	println(typeof(ret))
	return ret
end

typealias ChunkID Tuple{Int,Int,Int,Int}
type ChunkedGraph
	graphs::Dict{ChunkID,Any}
	vertices::Dict
	root

	function ChunkedGraph()
		d=Dict{ChunkID,Any}()
		ret = new(d,Dict(),nothing)
		d[TOP_ID]=Chunk(ret,TOP_ID,nothing)
		ret.root=d[TOP_ID]
		return ret
	end
end
type Vertex{T}
	label::T
	parent
	G
	children
end
type Edge
	head
	tail
end

function get_chunk(g::ChunkedGraph, id::ChunkID)
	if !haskey(g.graphs,id)
		g.graphs[id]=Chunk(G, id, get_chunk(g,parent(id)))
	end
	return g.graphs[id]
end

type Chunk
	chunked_graph::ChunkedGraph
	graph
	id::ChunkID
	parent::Union{Chunk,Void}
	subgraphs::Set
	added_vertices::Set
	deleted_vertices::Set
	added_edges::Set
	deleted_edges::Set
	clean::Bool
	function Chunk(G,id,par)
		d=new(G,MultiGraphs.MultiGraph(),id,par,Set(),Set(),Set(),Set(),Set(),true)
		if par != nothing
			push!(par.subgraphs,d)
		end
		return d
	end
end
function Base.show(io::IO,x::Chunk)
	write(io, "Chunk(id=$(x.id)),#added_edges=$(length(x.added_edges)),#added_vertices=$(length(x.added_vertices))),clean=$(x.clean)")
end
function Base.show(io::IO,v::Vertex)
	write(io, "Vertex(id=$(v.label)),parent=$(v.parent)")
end

function update(c::Chunk)
	if !c.clean
		for s in c.subgraphs
			update(s)
		end
		println("updating $(c.id)")

		dirty_vertices=Set([])

		for v in c.deleted_vertices
			MultiGraphs.delete_vertex!(c.graph,v)
			push!(dirty_vertices, v)
		end

		for v in c.added_vertices
			@assert v.parent ==nothing
			@assert v.G==c
			MultiGraphs.add_vertex!(c.graph,v)
			push!(dirty_vertices,v)
		end

		for e in c.deleted_edges
			u,v=lcp(map(x->get_atomic_vertex(c.chunked_graph,x),e)...)
			@assert u.G == c
			@assert v.G == c
			MultiGraphs.delete_edge!(c.graph,u,v,e)
			push!(dirty_vertices,u)
			push!(dirty_vertices,v)
		end

		for e in c.added_edges
			u,v=lcp(map(x->get_atomic_vertex(c.chunked_graph,x),e)...)
			@assert u.G == c
			@assert v.G == c
			MultiGraphs.add_edge!(c.graph,u,v,e)
			push!(dirty_vertices,u)
			push!(dirty_vertices,v)
		end

		if c.parent != nothing
			for v in dirty_vertices
				if v.parent != nothing
					push!(c.parent.deleted_vertices, v.parent)
				end
			end
		end

		if c.parent != nothing
			cc = MultiGraphs.connected_components(c.graph, dirty_vertices)
			for component in cc
				v=Vertex(unique_label(), nothing, c.parent,component)
				for child in component
					child.parent=v
				end
				push!(c.parent.added_vertices,v)
				c.parent.clean=false
			end
		end

		c.added_edges=Set([])
		c.added_vertices=Set([])
		c.clean=true
	end
end

function get_atomic_vertex(g::ChunkedGraph, label)
	return g.vertices[label]
end

function is_root(c::Chunk)
	return c.id == TOP_ID
end
function is_leaf(v::Vertex)
	return v.children == nothing
end



const TOP_ID=convert(ChunkID,(1000,0,0,0))
@inline function parent(t::ChunkID)
	if t[1] > 4
		return TOP_ID
	else 
		return (Int(t[1]+1),int_div(t[2],bx),int_div(t[3],by),int_div(t[4],bz))
	end
end

function parent(v::Vertex)
	return v.parent
end
function parent(c::Chunk)
	return c.parent
end

MAX_LABEL=0
function unique_label()
	global MAX_LABEL
	MAX_LABEL+=1
	return MAX_LABEL
end

function lcp(v1,v2)
	if v1.G == v2.G
		return (v1,v2)
	else
		return lcp(parent(v1),parent(v2))
	end
end

function lca(t1,t2)
	if t1 == t2
		return t1
	else
		return lca(parent(t1),parent(t2))
	end
end
function chunk_id(label)
	return label[2]
end

function level(id::ChunkID)
	return id[1]
end

function touch(x::Void)
end
function touch(x)
	x.clean=false
	touch(x.parent)
end

function add_atomic_vertex!(G::ChunkedGraph, label)
	s = get_chunk(G, chunk_id(label))
	v=Vertex(label,nothing,s,nothing)
	G.vertices[label]=v
	MultiGraphs.add_vertex!(s.graph,v)
	push!(s.added_vertices, v)
	touch(s)
end

function add_atomic_edge!(G::ChunkedGraph, edge)
	s=lca(get_chunk(G,chunk_id(edge[1])),get_chunk(G,chunk_id(edge[2])))
	push!(s.added_edges,edge)
	touch(s)
end

function delete_atomic_edge!(G::ChunkedGraph, edge)
	s=lca(get_chunk(G,chunk_id(edge[1])),get_chunk(G,chunk_id(edge[2])))

	push!(s.deleted_edges, edge)
	touch(s)
end

function adam(v)
	if v.parent == nothing
		@assert is_root(v.G)
		return v
	else
		return adam(v.parent)
	end
end

function bfs(G::ChunkedGraph, label)
	return MultiGraphs.connected_components(G.root.graph,[adam(G.vertices[label])])[1]
end

function leaves(v::Vertex)
	if is_leaf(v)
		return [v.label]
	else
		return cat(1,map(leaves,v.children)...)
	end
end


#=
include("../pre/compute_regiongraph.jl")
raw=load("~/mydatasets/3_3_1/raw.h5")
machine_labels=load("~/mydatasets/3_3_1/mean_agg_tr.h5")
edges = compute_regiongraph2(chunked_labelling(raw),machine_labels, flatten=false)
Save.save("~/mydatasets/3_3_1/chunked_edges.jls",edges)
=#
edges = load("~/mydatasets/3_3_1/chunked_edges.jls")
vertices = collect(Set(cat(1,[x[1] for x in edges],[x[2] for x in edges])))
println(length(edges))
println(length(vertices))

G=ChunkedGraph()
for v in vertices
	add_atomic_vertex!(G,v)
end

for e in edges
	add_atomic_edge!(G,e)
end

update(G.root)
