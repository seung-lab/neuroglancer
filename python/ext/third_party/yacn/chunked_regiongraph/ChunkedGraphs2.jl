module ChunkedGraphs2

export update!, ChunkedGraph, add_atomic_edge!, add_atomic_vertex!, delete_atomic_edge!, leaves, bfs, add_atomic_vertices!, add_atomic_edges!, get_vertex, leaves, bfs

import DataStructures
using Save
using Iterators
import MultiGraphs
using Utils

#####Chunk Ids#####
include("constants.jl")
const MAX_DEPTH=5
const TOP_ID=ChunkID(MAX_DEPTH+1,0,0,0)
const NULL_LABEL=typemax(UInt64)
const NULL_LIST=Vector{Label}[]

#=
macro assert(ex)
	return quote end
end
=#

function is_root(c::ChunkID)
	return c == TOP_ID
end
@inline function parent(t::ChunkID)
	if level(t) >= MAX_DEPTH
		return TOP_ID
	else 
		x,y,z=pos(t)
		return ChunkID(level(t)+1,fld(x,bx),fld(y,by),fld(z,bz))
	end
end

function lca(t1,t2)
	if t1 == t2
		return t1
	else
		return lca(parent(t1),parent(t2))
	end
end

type Vertex
	label::Label
	parent::Label
	children::Vector{Label}
end


import Base: ==, hash
==(x::Vertex,y::Vertex) = (x.label == y.label)
Base.hash(v::Vertex) = Base.hash(v.label)
function Utils.chunk_id(v::Vertex)
	chunk_id(v.label)
end

type ChunkedGraph{C}
	graphs::Dict{ChunkID,C}
	path::Union{String,Void}
end

function ChunkedGraph(path)
	return ChunkedGraph{Chunk}(Dict{ChunkID,Chunk}(),path)
end

const AtomicEdge = Tuple{Label,Label}

#The 'added' and 'deleted' sets buffer updates to the graph
type Chunk
	chunked_graph::ChunkedGraph{Chunk}
	graph::MultiGraphs.MultiGraph{Label,AtomicEdge}
	id::ChunkID
	vertices::Dict{Label,Vertex}
	parent::Union{Chunk,Void}
	subgraphs::Array{Chunk,1}
	added_vertices::Set{Vertex}
	deleted_vertices::Set{Vertex}
	added_edges::Set{AtomicEdge}
	deleted_edges::Set{AtomicEdge}
	clean::Bool
	modified::Bool
	max_label::UInt32

	function Chunk(G,id)
		d=new(G,MultiGraphs.MultiGraph(Label,AtomicEdge),id,Dict{Label,Vertex}(),nothing,Chunk[],Set{Vertex}(),Set{Vertex}(),Set{AtomicEdge}(),Set{AtomicEdge}(),true,false,0)

		if !is_root(id)
			par=get_chunk(G,parent(id))
			push!(par.subgraphs,d)
			d.parent=par
		end
		return d
	end

	function Chunk(G,id,vertices,graph,max_label)
		d=new(G,graph,id,vertices,nothing,Chunk[],Set{Vertex}(),Set{Vertex}(),Set{AtomicEdge}(),Set{AtomicEdge}(),true,false,max_label)

		if !is_root(id)
			par=get_chunk(G,parent(id))
			push!(par.subgraphs,d)
			d.parent=par
		end
		return d
	end
end

Utils.level(c::Chunk) = Utils.level(c.id)
Utils.level(v::Vertex) = Utils.level(chunk_id(v))
function Utils.chunk_id(c::Chunk)
	c.id
end

function is_root(c::Chunk)
	return is_root(c.id)
end

function get_chunk(g::ChunkedGraph, id::ChunkID)
	if !haskey(g.graphs,id)
		tmp=nothing
		if g.path !=nothing
			tmp=load_chunk(g, id)
		end
		if tmp==nothing
			tmp = Chunk(g,id)
		end
		g.graphs[id]=tmp::Chunk
	end
	return g.graphs[id]::Chunk
end

function parent(c::Chunk)
	return get_chunk(c.chunked_graph, parent(c.id))
end

function save_chunk(c::Chunk)
	@assert c.clean
	prefix=to_string(c.id)
	Save.save(joinpath(c.chunked_graph.path,"$(prefix)_vertices.jls"),collect(values(c.vertices)))
	Save.save(joinpath(c.chunked_graph.path,"$(prefix)_graph.jls"),c.graph)
	Save.save(joinpath(c.chunked_graph.path,"$(prefix)_max_label.jls"),c.max_label)
	c.modified=false
end

function save!(c::ChunkedGraph)
	println("Saving...")
	for c in collect(values(c.graphs))
		save_chunk(c)
	end
	println("done")
end

function evict!(c::Chunk)
	@assert c.clean
	for s in c.subgraphs
		evict!(s)
	end
	if c.modified
		save_chunk!(c)
	end
	if !is_root(c)
		delete!(c.parent.subgraphs, c)
	end
	delete!(c.chunked_graph.graphs, c)
end

function to_string(id::ChunkID)
	x,y,z=pos(id)
	return "$(level(id))_$(x)_$(y)_$(z)"
end

function load_chunk(G::ChunkedGraph,id)
	vertices=nothing
	graph=nothing
	max_label=nothing
	#try
		prefix=to_string(id)
		vertices=Save.load(joinpath(G.path,"$(prefix)_vertices.jls"))
		graph=Save.load(joinpath(G.path,"$(prefix)_graph.jls"))
		max_label=Save.load(joinpath(G.path,"$(prefix)_max_label.jls"))
	#catch
	#	println("failed.")
	#	return nothing
	#end
	vertices_dict=Dict{Label,Vertex}()
	sizehint!(vertices_dict, length(vertices))
	for v in vertices
		vertices_dict[v.label]=v
	end

	return Chunk(G,id,vertices_dict,graph,max_label)
end

function get_vertex(g::ChunkedGraph, label)
	return get_chunk(g,chunk_id(label)).vertices[label]
end

function lcG(G, v1::Vertex, v2::Vertex)
	if chunk_id(v1) == chunk_id(v2)
		return (v1,v2)
	else
		if v1.parent == NULL_LABEL
			promote!(G,v1)
		end
		if v2.parent == NULL_LABEL
			promote!(G,v2)
		end
		p1 = get_vertex(G,v1.parent)
		p2 = get_vertex(G,v2.parent)
		@assert p1.label == v1.parent
		@assert p2.label == v2.parent
		return lcG(G, p1,p2)
	end
end

function promote!(G,v)
	c=get_chunk(G,chunk_id(v))

	@assert c.clean
	@assert v.parent == NULL_LABEL
	@assert length(MultiGraphs.incident_edges(c.graph,v.label))==0
	c=get_chunk(G,chunk_id(v))
	l=unique_label(c.parent)
	pv=Vertex(l, NULL_LABEL, Label[v.label])
	v.parent=pv.label

	@assert chunk_id(pv) == c.parent.id
	MultiGraphs.add_vertex!(c.parent.graph,pv.label)
	c.parent.vertices[pv.label]=pv
	c.parent.modified=true
end

function touch(x::Void)
end
function touch(x::Chunk)
	if x.clean
		x.clean=false
		x.modified=true
		touch(x.parent)
	end
end

function is_leaf(x)
	return level(x)==1
end

function leaves(G,v::Vertex)
	if is_leaf(v)
		return [v.label]
	else
		return cat(1,map(x->leaves(G,get_vertex(G,x)),v.children)...)
	end
end

function is_root(v::Vertex)
	if v.parent == NULL_LABEL
		return true
	else
		return false
	end
end
function root(G,x)
	if is_root(x)
		return x
	else
		return root(G,get_vertex(G,x.parent))
	end
end

#####Graph operations#####

function update!(c::ChunkedGraph)
	gc_enable(false)
	update!(get_chunk(c,TOP_ID))
	println("updated")
	gc_enable(true)
end

n_processed=0

function print_chunk_id(x::ChunkID)
	println("$(level(x)), $(map(Int,pos(x)))")
end


function update!(c::Chunk)
	if !c.clean
		for s in c.subgraphs
			update!(s)
		end
		println("updating $(level(c.id)), $(map(Int,pos(c.id))), $(length(c.added_vertices)), $(length(c.added_edges))")
		global n_processed
		n_processed+=1
		println("$n_processed/$(length(c.chunked_graph.graphs))")

		#vertices that are being deleted from c.G
		dead_dirty_vertices=Set{Vertex}()

		#vertices which need updates
		dirty_vertices=Set{Vertex}()

		upsize!(c.graph, length(c.added_vertices), length(c.added_edges))
		upsize!(c.vertices, length(c.added_vertices))

		for v in c.deleted_vertices
			for child in v.children
				#@assert get_vertex(c.chunked_graph,child).parent==NULL_LABEL
			end

			for e in MultiGraphs.incident_edges(c.graph, v.label)
				push!(c.added_edges, e)
			end

			#this should delete all edges incident with v as well
			MultiGraphs.delete_vertex!(c.graph,v.label)
			delete!(c.vertices,v.label)

			push!(dead_dirty_vertices, v)
		end

		for v in c.added_vertices
			@assert chunk_id(v) == c.id
			@assert v.parent ==NULL_LABEL
			@assert !haskey(c.vertices,v.label)
			MultiGraphs.add_vertex!(c.graph,v.label)
			c.vertices[v.label]=v
			push!(dirty_vertices,v)
		end

		for e in c.deleted_edges
			u,v=lcG(c.chunked_graph, map(x->get_vertex(c.chunked_graph,x),e)...)
			@assert chunk_id(u) == chunk_id(c)
			@assert chunk_id(v) == chunk_id(c)
			MultiGraphs.delete_edge!(c.graph,u.label,v.label,e)
			push!(dirty_vertices,u)
			push!(dirty_vertices,v)
		end

		for e in c.added_edges
			u,v=lcG(c.chunked_graph, map(x->get_vertex(c.chunked_graph,x),e)...)
			@assert chunk_id(u) == chunk_id(c)
			@assert chunk_id(v) == chunk_id(c)
			@assert haskey(c.vertices,u.label)
			@assert haskey(c.vertices,v.label)

			@assert haskey(c.graph.vertex_map,u.label)
			@assert haskey(c.graph.vertex_map,v.label)
			MultiGraphs.add_edge!(c.graph,u.label,v.label,e)
			push!(dirty_vertices,u)
			push!(dirty_vertices,v)
		end

		if !is_root(c)
			for v in chain(dirty_vertices, dead_dirty_vertices)
				if v.parent != NULL_LABEL
					@assert chunk_id(v.parent)==chunk_id(c.parent)
					push!(c.parent.deleted_vertices, c.parent.vertices[v.parent])
					v.parent = NULL_LABEL
				end
			end

			cc = MultiGraphs.connected_components(c.graph, map(x->x.label,dirty_vertices))
			for component in cc
				if length(component) > 1
					l=unique_label(c.parent)
					new_vertex=Vertex(l, NULL_LABEL, component)
					for child_label in component
						c.vertices[child_label].parent=new_vertex.label
					end
					push!(c.parent.added_vertices,new_vertex)
				else
					c.vertices[component[1]].parent=NULL_LABEL
				end
			end
			c.parent.clean=false
		end

		empty!(c.added_edges)
		empty!(c.added_vertices)
		empty!(c.deleted_edges)
		empty!(c.deleted_vertices)
		c.clean=true
	end
end


function unique_label(chunk::Chunk)
	chunk.max_label+=1
	return Label(chunk.max_label,chunk.id)
end


function add_atomic_vertex!(G::ChunkedGraph, label)
	@assert level(chunk_id(label))==1
	s=get_chunk(G,chunk_id(label))::Chunk
	if !haskey(s.vertices,label)
		v=Vertex(label,NULL_LABEL,NULL_LIST)
		push!(s.added_vertices, v)
		touch(s)
	end
end

function add_atomic_edge!(G::ChunkedGraph, edge::Tuple{Label,Label})
	s=get_chunk(G,lca(chunk_id(edge[1]),chunk_id(edge[2])))::Chunk
	push!(s.added_edges,unordered(edge))
	touch(s)
end

function add_atomic_edges!(G::ChunkedGraph, edges)
	for i in 1:length(edges)
		edges[i]=unordered(edges[i])
	end
	sort!(edges)
	gc_enable(false)
	for (i,e) in enumerate(edges)
		if i%100000 == 0
			println("$i / $(length(edges))")
		end

		add_atomic_edge!(G,e)
	end
	gc_enable(true)
end

function upsize!(A,n)
	sizehint!(A,length(A)+n)
end
function upsize!(G::MultiGraphs.MultiGraph,n_v,n_e)
	upsize!(G.vertex_map,n_v)
	upsize!(G.inverse_vertex_map,n_v)
	upsize!(G.g.fadjlist,n_v)
	upsize!(G.edge_map,n_e)
end

function add_atomic_vertices!(G::ChunkedGraph, vertices)
	gc_enable(false)
	for (i,v) in enumerate(vertices)
		add_atomic_vertex!(G,v)
	end
	gc_enable(true)
end

function delete_atomic_edge!(G::ChunkedGraph, edge)
	s=get_chunk(G,lca(chunk_id(edge[1]),chunk_id(edge[2])))

	push!(s.deleted_edges, unordered(edge))
	touch(s)
end


function bfs(G::ChunkedGraph, label)
	#wrong
	return [root(G,get_vertex(G,label))]
end

end

