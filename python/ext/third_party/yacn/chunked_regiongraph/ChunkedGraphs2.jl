module ChunkedGraphs2

export update!, ChunkedGraph, add_atomic_edge!, add_atomic_vertex!, delete_atomic_edge!, add_atomic_vertices!, add_atomic_edges!, get_vertex, leaves, bfs, root

import DataStructures
using Save
using Iterators
import MultiGraphs
using Utils
using DataStructures

#####Chunk Ids#####
include("constants.jl")
const MAX_DEPTH=3
const TOP_ID=ChunkID(MAX_DEPTH+1,0,0,0)
const SECOND_ID=ChunkID(MAX_DEPTH,0,0,0)
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
	elseif level(t) == MAX_DEPTH - 1
		return SECOND_ID
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
	last_used::PriorityQueue{ChunkID,Float64}
	path::Union{String,Void}
end

function ChunkedGraph(path)
	return ChunkedGraph{Chunk}(Dict{ChunkID,Chunk}(),DataStructures.PriorityQueue(ChunkID,Float64),path)
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

eviction_mode=false
const CACHE_SIZE = 40000
function get_chunk(g::ChunkedGraph, id::ChunkID)
	global eviction_mode
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
	ret=g.graphs[id]::Chunk
	if !eviction_mode
		if level(ret.id) == 1
			g.last_used[ret.id]=time()
		end
		eviction_mode=true
		while length(g.graphs) > CACHE_SIZE
			evict!(g.graphs[DataStructures.peek(g.last_used)[1]])
		end
		eviction_mode=false
	else
		if level(ret.id) == 1
			if !haskey(g.last_used,ret.id)
				g.last_used[ret.id]=0
			end
		end
	end
	return ret
end

function parent(c::Chunk)
	return get_chunk(c.chunked_graph, parent(c.id))
end

function save_chunk!(c::Chunk)
	@assert c.clean

	prefix = to_string(c.id)
	path = expanduser(joinpath(c.chunked_graph.path, "$(prefix).chunk"))
	print("Saving to $(path)...")

	buf = IOBuffer()
	write(buf, UInt64(1)) # Version
	write(buf, UInt64(c.max_label)) # Max SegID
	write(buf, UInt64(length(c.vertices))) # Vertex Count
	write(buf, UInt64(length(LightGraphs.edges(c.graph.g)))) # Edge Count
	
	for vertex in values(c.vertices)
		write(buf, UInt64(vertex.label)) # Vertex Label
		write(buf, UInt64(vertex.parent)) # Vertex Parent
		write(buf, UInt64(length(vertex.children))) # Vertex Children Count
		write(buf, convert(Vector{UInt64}, vertex.children))
	end
	
	if length(LightGraphs.edges(c.graph.g)) > 0
		write(buf, map(v->c.graph.inverse_vertex_map[v], collect(UInt64, Base.flatten(LightGraphs.edges(c.graph.g)))))
	end

	f = open(path, "w")
	write(f, buf.data)
	close(f)
	close(buf)
	println("done.")

	c.modified = false
end

function save!(c::ChunkedGraph)
	println("Saving...")
	for c in collect(values(c.graphs))
		save_chunk!(c)
	end
	println("done")
end

function evict!(c::Chunk)
	@assert !is_root(c)
	@assert c.id != SECOND_ID
	#@assert c.clean
	update!(c)
	while !isempty(c.subgraphs)
		evict!(c.subgraphs[end])
	end
	if c.modified
		save_chunk!(c)
	end
	filter!(x->x!=c, c.parent.subgraphs)
	delete!(c.chunked_graph.graphs, c.id)
	dequeue!(c.chunked_graph.last_used, c.id)
	println("Evicted $(c.id)")
end

function to_string(id::ChunkID)
	x,y,z=pos(id)
	return "$(level(id))_$(x)_$(y)_$(z)"
end

function load_chunk(G::ChunkedGraph,id)
	vertices = nothing
	graph = nothing
	max_label = nothing
	try
		prefix=to_string(id)
		path = expanduser(joinpath(G.path, "$(prefix).chunk"))
		print("Loading from $(path)...")

		# Plain Binary
		max_label = UInt64(0)
		vertices = Vector{Vertex}()
		edges = Vector{Tuple{UInt64, UInt64}}()

		f = open(path, "r")

		# Check File Version
		version = read(f, UInt64)
		@assert version === UInt64(1)

		# Read Chunk Info
		(max_label, v_cnt, e_cnt) = read(f, UInt64, 3)

		# Read Vector{Vertex}
		resize!(vertices, v_cnt)
		for i in range(1, v_cnt)
			(label, parent, child_cnt) = read(f, UInt64, 3)
			children = read(f, UInt64, child_cnt)
			@inbounds vertices[i] = Vertex(label, parent, children)
		end
		
		# Read Vector{AtomicEdge}
		edges = read(f, Tuple{UInt64, UInt64}, e_cnt)

		# Rebuild Graph
		graph = MultiGraphs.MultiGraph(Label, AtomicEdge)
		MultiGraphs.sizehint!(graph, v_cnt, e_cnt)

		for v in vertices
			MultiGraphs.add_vertex!(graph, v.label)
		end

		for e in edges
			MultiGraphs.add_edge!(graph, e[1], e[2], e)
		end

		close(f)
		println("done.")
	catch
		try
			prefix=to_string(id)
			vertices=Save.load(joinpath(G.path,"$(prefix)_vertices.jls"))
			graph=Save.load(joinpath(G.path,"$(prefix)_graph.jls"))
			max_label=Save.load(joinpath(G.path,"$(prefix)_max_label.jls"))
		catch e
			println("failed: $e")
			return nothing
		end
	end


	vertices_dict = Dict{Label,Vertex}()
	sizehint!(vertices_dict, floor(UInt32, 1.5 * length(vertices)))
	for v in vertices
		vertices_dict[v.label] = v
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

	return pv
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
	elseif level(v)==2
		return v.children
	else
		return cat(1,map(x->leaves(G,get_vertex(G,x)),v.children)...)
	end
end
function leaves(G,v::Vertex,l::Integer)
	@assert level(chunk_id(v)) > l
	if is_leaf(v)
		return [v.label]
	elseif level(v)==l+1
		return v.children
	else
		return cat(1,map(x->leaves(G,get_vertex(G,x),l),v.children)...)
	end
end

const Cuboid = Tuple{UnitRange,UnitRange,UnitRange}
const BIG=1000000
function to_cuboid(id::ChunkID)
	@assert level(id) >= 1

	if id==TOP_ID || id==SECOND_ID
		return (-BIG:BIG,-BIG:BIG,-BIG:BIG)
	end
	l=2^(level(id)-1)
	x,y,z=pos(id)

	return (x*l:(x+1)*l, y*l:(y+1)*l, z*l:(z+1)*l)::Cuboid
end

function overlaps(r1::UnitRange,r2::UnitRange)
	return r1.start <= r2.stop && r2.start <= r1.stop
end
function overlaps(c1::Cuboid,c2::Cuboid)
	return all(map(overlaps, c1, c2))
end

function leaves(G,v::Vertex, cuboid::Cuboid)
	if overlaps(to_cuboid(chunk_id(v)),cuboid)
		if is_leaf(v)
			return [v.label]
		else
			return cat(1,map(x->leaves(G,get_vertex(G,x)),v.children)...)
		end
	else
		return Vertex[]
	end
end

#vertices should be a collection of labels
function induced_subgraph(G,chunk,vertices,cuboid)
	filter!(v->overlaps(to_cuboid(chunk_id(v)),cuboid),vertices)
	if !overlaps(to_cuboid(chunk_id(chunk)), cuboid)
		return Label[], Tuple{Label,Label}[]
	end

	for v in vertices
		@assert haskey(chunk.vertices, v)
		V=chunk.vertices[v]
		for child in V.children
			if overlaps(to_cuboid(chunk_id(child)),cuboid)
				get_vertex(G,child)
				@assert get_chunk(G,chunk_id(child)) in chunk.subgraphs
				@assert get_chunk(G,chunk_id(child))==get_chunk(G,chunk_id(V.children[1]))
			end
		end
	end
	atomic_edges = cat(1,values(MultiGraphs.induced_edges(chunk.graph, filter(vert -> haskey(chunk.vertices,vert),vertices)))...)
	atomic_vertices = Label[]
	
	if level(chunk) > 1
		children = cat(1,[chunk.vertices[v].children for v in vertices]...)
		for s in chunk.subgraphs
			s_vertices,s_edges = induced_subgraph(G,s, filter(c-> chunk_id(c) == chunk_id(s),children),cuboid)
			append!(atomic_vertices, s_vertices)
			append!(atomic_edges, s_edges)
		end
	else
		@assert length(chunk.subgraphs) == 0
		append!(atomic_vertices, vertices)
	end

	atomic_vertices = unique(atomic_vertices)
	return atomic_vertices, collect(filter(e->e[1] in atomic_vertices && e[2] in atomic_vertices, atomic_edges))
end

import LightGraphs
function min_cut(G,v1,v2)
	@assert level(chunk_id(v1))==1
	@assert level(chunk_id(v2))==1
	x1,y1,z1=pos(chunk_id(v1))
	x2,y2,z2=pos(chunk_id(v2))

	cuboid=(min(x1,x2)-2:max(x1,x2)+2, min(y1,y2)-2:max(y1,y2)+2, min(z1,z2)-2:max(z1,z2)+2)
	r1=root(G,get_vertex(G,v1))
	r2=root(G,get_vertex(G,v2))

	while level(chunk_id(r1.label)) < level(chunk_id(r2.label))
		r1=promote!(G,r1)
	end
	while level(chunk_id(r2.label)) < level(chunk_id(r1.label))
		r2=promote!(G,r2)
	end

	r1,r2 = lcG(G, r1, r2)
	chunk = get_chunk(G,chunk_id(r1))
	atomic_vertices, atomic_edges=induced_subgraph(G, chunk, [r1.label,r2.label], cuboid)


	encode=Dict()
	decode=Dict()
	for (i,v) in enumerate(atomic_vertices)
		encode[v]=i
		decode[i]=v
	end

	N=length(encode)
	flow_graph = LightGraphs.DiGraph(N)
	capacities = zeros(N,N)
	for (u,v) in atomic_edges
		LightGraphs.add_edge!(flow_graph,encode[u],encode[v])
		LightGraphs.add_edge!(flow_graph,encode[v],encode[u])
		capacities[encode[u],encode[v]] = seg_id(u) == seg_id(v) ? 1000000 : 1 # Don't split supervoxels at chunk boundaries
		capacities[encode[v],encode[u]] = seg_id(u) == seg_id(v) ? 1000000 : 1
	end

	_,_,labels= LightGraphs.multiroute_flow(flow_graph, encode[v1], encode[v2], capacities, flow_algorithm = LightGraphs.BoykovKolmogorovAlgorithm(),routes=1)
	@assert length(labels)==N
	@assert labels[encode[v1]]!=labels[encode[v2]]
	println(unique(labels))
	ret = filter(e->labels[encode[e[1]]]!=labels[encode[e[2]]], atomic_edges)
	for (a,b) in ret
		println("Cut: $(level(chunk_id(a))), $(map(Int,pos(chunk_id(a)))), $(seg_id(a)) | $(level(chunk_id(b))), $(map(Int,pos(chunk_id(b)))), $(seg_id(b))")
	end
	return ret
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
		println("updating $(level(c.id)), $(map(Int,pos(c.id))), V: +$(length(c.added_vertices))/-$(length(c.deleted_vertices)), E: +$(length(c.added_edges))/-$(length(c.deleted_edges))")
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
			# for child in v.children
			#	@assert get_vertex(c.chunked_graph,child).parent==NULL_LABEL
			# end

			for e in MultiGraphs.incident_edges(c.graph, v.label)
				push!(dirty_vertices, get_vertex(c.chunked_graph, e[1] === v.label ? e[2] : e[1]))
			end

			# this should delete all edges incident with v as well
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
	@assert level(chunk_id(label))==1 "$(level(chunk_id(label))) == 1"
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

