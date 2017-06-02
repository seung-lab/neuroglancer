module ChunkedGraphs

export update!, ChunkedGraph, add_atomic_edge!, add_atomic_vertex!, delete_atomic_edge!, leaves, bfs

import DataStructures
using Save
using Iterators
import MultiGraphs

const Int=Int32

#####Chunk Ids#####
const bx = 2
const by = 2
const bz = 2


#The first element represents level, the last three represent location
typealias ChunkID Tuple{Int,Int,Int,Int}

const MAX_DEPTH=5
const TOP_ID=convert(ChunkID,(MAX_DEPTH,0,0,0))
@inline function parent(t::ChunkID)
	if t[1] >= MAX_DEPTH
		return TOP_ID
	else 
		return convert(ChunkID,(t[1]+1,fld(t[2],bx),fld(t[3],by),fld(t[4],bz)))
	end
end

#TODO: change VOID objects to nullables
#TODO: make all vertices have labels of the same type
#####Chunked graph types#####
type ChunkedGraph{C,V}
	graphs::Dict{ChunkID, C}
	vertices::Dict{Any, V}
	root::Union{C,Void}
end
function ChunkedGraph()
	d=Dict{ChunkID,Chunk}()
	ret = ChunkedGraph{Chunk,Vertex}(d,Dict{Any,Vertex}(),nothing)
	d[TOP_ID]=Chunk(ret,TOP_ID,nothing)
	ret.root=d[TOP_ID]
	return ret
end

type Vertex{C}
	label::Any
	parent::Union{Vertex,Void}
	G::C
	children
end

#The 'added' and 'deleted' sets buffer updates to the graph
type Chunk
	chunked_graph::ChunkedGraph{Chunk,Vertex}
	graph::MultiGraphs.MultiGraph
	id::ChunkID
	parent::Union{Chunk,Void}
	subgraphs::Array{Chunk,1}
	added_vertices::Set{Vertex}
	deleted_vertices::Set{Vertex}
	added_edges::Set
	deleted_edges::Set
	clean::Bool
	function Chunk(G,id,par)
		d=new(G,MultiGraphs.MultiGraph(),id,par,Chunk[],Set{Vertex}(),Set{Vertex}(),Set(),Set(),true)
		if par != nothing
			push!(par.subgraphs,d)
		end
		return d
	end
end

function Base.show(io::IO,x::Chunk)
	write(io, "Chunk(id=$(x.id)),clean=$(x.clean)")
end
function Base.show(io::IO,v::Vertex)
	write(io, "Vertex(label=$(v.label),parent=$(v.parent))")
end

function get_chunk(g::ChunkedGraph, id::ChunkID)
	if !haskey(g.graphs,id)
		g.graphs[id]=Chunk(g, id, get_chunk(g,parent(id)))
	end
	return g.graphs[id]
end

function get_atomic_vertex(g::ChunkedGraph, label)
	return g.vertices[label]
end

#####Tree utility functions#####
level(c::Chunk) = level(c.id)
level(id::ChunkID) = id[1]
level(v::Vertex) = level(v.G)

function is_root(c::Chunk)
	return c.id == TOP_ID
end
function is_root(v::Vertex)
	if v.parent == nothing
		@assert is_root(v.G)
		return true
	else
		return false
	end
end
function root(x)
	if is_root(x)
		return x
	else
		return root(parent(x))
	end
end
function is_leaf(v::Vertex)
	return v.children == nothing
end

#TODO: remove log(n) overhead
function leaves(v::Vertex)
	if is_leaf(v)
		return [v.label]
	else
		return cat(1,map(leaves,v.children)...)
	end
end
parent(v::Vertex) = v.parent
parent(c::Chunk) = c.parent

function lcG(v1,v2)
	if v1.G == v2.G
		return (v1,v2)
	else
		return lcG(parent(v1),parent(v2))
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

function touch(x::Void)
end
function touch(x::Chunk)
	x.clean=false
	touch(x.parent)
end


#####Graph operations#####
function unordered{T}(x::Tuple{T,T})
	a,b = x
	return (min(a,b),max(a,b))
end

function update!(c::Chunk)
	if !c.clean
		for s in c.subgraphs
			update!(s)
		end
		println("updating $(c.id)")

		#vertices that are being deleted from c.G
		dead_dirty_vertices=Set([])

		#vertices which need updates
		dirty_vertices=Set([])

		for v in c.deleted_vertices
			for e in MultiGraphs.incident_edges(c.graph, v)
				push!(c.added_edges, e)
			end

			#this should delete all edges incident with v as well
			MultiGraphs.delete_vertex!(c.graph,v)

			push!(dead_dirty_vertices, v)
		end

		for v in c.added_vertices
			@assert v.parent ==nothing
			@assert v.G==c
			MultiGraphs.add_vertex!(c.graph,v)
			push!(dirty_vertices,v)
		end

		for e in c.deleted_edges
			u,v=lcG(map(x->get_atomic_vertex(c.chunked_graph,x),e)...)
			@assert u.G == c
			@assert v.G == c
			MultiGraphs.delete_edge!(c.graph,u,v,e)
			push!(dirty_vertices,u)
			push!(dirty_vertices,v)
		end

		for e in c.added_edges
			u,v=lcG(map(x->get_atomic_vertex(c.chunked_graph,x),e)...)
			@assert u.G == c
			@assert v.G == c
			MultiGraphs.add_edge!(c.graph,u,v,e)
			push!(dirty_vertices,u)
			push!(dirty_vertices,v)
		end

		if !is_root(c)
			for v in chain(dirty_vertices, dead_dirty_vertices)
				if v.parent != nothing
					push!(c.parent.deleted_vertices, v.parent)
				end
			end

			cc = MultiGraphs.connected_components(c.graph, dirty_vertices)
			for component in cc
				v=Vertex(unique_label(), nothing, c.parent,component)
				for child in component
					child.parent=v
				end
				v.children=component
				push!(c.parent.added_vertices,v)
			end
			c.parent.clean=false
		end

		c.added_edges=Set([])
		c.added_vertices=Set{Vertex}([])
		c.deleted_edges=Set([])
		c.deleted_vertices=Set{Vertex}([])
		c.clean=true
	end
end



MAX_LABEL=0
function unique_label()
	global MAX_LABEL
	MAX_LABEL+=1
	return MAX_LABEL
end


function add_atomic_vertex!(G::ChunkedGraph, label)
	s = get_chunk(G, chunk_id(label))
	v=Vertex(label,nothing,s,nothing)
	G.vertices[label]=v
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

	push!(s.deleted_edges, unordered(edge))
	touch(s)
end


function bfs(G::ChunkedGraph, label)
	v=root(G.vertices[label])
	chunk=v.G
	return MultiGraphs.connected_components(chunk.graph,[v])[1]
end



end

