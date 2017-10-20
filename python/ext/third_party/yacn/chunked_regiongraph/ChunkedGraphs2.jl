module ChunkedGraphs2

export update!, save!, ChunkedGraph
#TODO add_atomic_vertex should call be able to 
#take a single vertex or a list of them
export delete_atomic_vertex!, add_atomic_vertex!, add_atomic_vertices! 
export delete_atomic_edge!, add_atomic_edges!, add_atomic_edge!
export get_vertex, leaves, bfs, root
export min_cut

import DataStructures
using Save
using Iterators
import MultiGraphs
using Utils
using DataStructures
using CloudVolume

#####Chunk Ids#####
include("constants.jl")
const MAX_DEPTH=8
const TOP_ID=ChunkID(MAX_DEPTH+1,0,0,0)
const SECOND_ID=ChunkID(MAX_DEPTH,0,0,0)
const NULL_LABEL=typemax(UInt64)
const NULL_LIST=Vector{Label}[]

type Vertex
	label::Label
	parent::Label
	children::Vector{Label}
end

#=
macro assert(ex)
	return quote end
end
=#

function is_root(c::ChunkID)
	return c == TOP_ID
end

@inline function parent_chunk(t::ChunkID)
	if level(t) >= MAX_DEPTH
		return TOP_ID
	elseif level(t) == MAX_DEPTH - 1
		return SECOND_ID
	else 
		x,y,z=pos(t)
		return ChunkID(level(t)+1,fld(x,bx),fld(y,by),fld(z,bz))
	end
end

function lca(t1::ChunkID, t2::ChunkID)
	if t1 == t2
		return t1
	else
		return lca(parent_chunk(t1),parent_chunk(t2))
	end
end

import Base: ==, hash
Base.:(==)(x::Vertex,y::Vertex) = isequal(x.label, y.label)
Base.hash(v::Vertex, h::UInt) = hash(v.label, hash(:Vertex, h))

function Utils.chunk_id(v::Vertex)
	chunk_id(v.label)
end

type ChunkedGraph{C}
	graphs::Dict{ChunkID,C}
	last_used::PriorityQueue{ChunkID,Float64}
	path::AbstractString
	cloudvolume::CloudVolumeWrapper
end

function ChunkedGraph(graphpath::AbstractString, cloudpath::AbstractString)
	return ChunkedGraph{Chunk}(
		Dict{ChunkID,Chunk}(),
		DataStructures.PriorityQueue(ChunkID,Float64),
		graphpath,
		CloudVolume.CloudVolumeWrapper(cloudpath, bounded = false, cache = true)
	)
end

function common_parent_vertices(G::ChunkedGraph, vertex_labels::Vector{Label})
	@assert length(vertex_labels) >= 1

	# Get unique set of root_vertices (not necessarily on top-level)
	root_vertex_set = Set{ChunkedGraphs2.Vertex}()
	for vertex_label in vertex_labels
		@assert level(chunk_id(vertex_label)) == 1
		push!(root_vertex_set, root(G, get_vertex(G, vertex_label)))
	end

	root_vertices = collect(root_vertex_set)

	# Make sure all root_vertices are on the same level
	max_level = max(map(r->level(chunk_id(r.label)), root_vertices)...)
	for i in eachindex(root_vertices)
		while level(chunk_id(root_vertices[i].label)) < max_level
			root_vertices[i] = promote!(G, root_vertices[i])
		end
	end

	# Make sure all root_vertices are in the same chunk (already on the same level)
	while length(unique(map(r->chunk_id(r), root_vertices))) !== 1
		root_vertices = map(r->promote!(G, r), root_vertices)
	end

	return root_vertices
end

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
	max_label::Label

	function Chunk(G::ChunkedGraph, id::ChunkID)
		d=new(G,MultiGraphs.MultiGraph(Label,AtomicEdge),id,Dict{Label,Vertex}(),nothing,Chunk[],Set{Vertex}(),Set{Vertex}(),Set{AtomicEdge}(),Set{AtomicEdge}(),true,false,0)

		if !is_root(id)
			par=get_chunk(G,parent_chunk(id))
			push!(par.subgraphs,d)
			d.parent=par
		end
		return d
	end

	function Chunk(G::ChunkedGraph, id::ChunkID, vertices::Dict{Label,Vertex}, graph::MultiGraphs.MultiGraph{Label,AtomicEdge}, max_label::Label)
		d=new(G,graph,id,vertices,nothing,Chunk[],Set{Vertex}(),Set{Vertex}(),Set{AtomicEdge}(),Set{AtomicEdge}(),true,false,max_label)

		if !is_root(id)
			par=get_chunk(G,parent_chunk(id))
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

function parent_chunk(c::Chunk)
	return get_chunk(c.chunked_graph, parent_chunk(c.id))
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
	
	for (edge, atomic_edges) in c.graph.edge_map
		write(buf, UInt64(c.graph.inverse_vertex_map[edge[1]]))
		write(buf, UInt64(c.graph.inverse_vertex_map[edge[2]]))
		write(buf, UInt64(length(atomic_edges)))
		write(buf, convert(Vector{AtomicEdge}, atomic_edges))
	end

	f = open(path, "w")
	write(f, buf.data)
	close(f)
	close(buf)
	println("done.")

	c.modified = false
end

function save!(c::ChunkedGraph, force::Bool = false)
	println("Saving...")
	for c in collect(values(c.graphs))
		if c.modified || force
			save_chunk!(c)
		end
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

function load_chunk(G::ChunkedGraph, id::ChunkID)
	vertex_map = nothing
	graph = nothing
	max_label = nothing

	try
		prefix=to_string(id)
		path = expanduser(joinpath(G.path, "$(prefix).chunk"))
		# print("Loading from $(path)...")

		# Plain Binary
		max_label = UInt64(0)
		vertex_map = Dict{Label, Vertex}()
		edge_map = Dict{Tuple{Int64, Int64}, Vector{AtomicEdge}}()

		f = open(path, "r")

		# Check File Version
		version = read(f, UInt64)
		@assert version === UInt64(1)

		# Read Chunk Info
		(max_label, v_cnt, e_cnt) = read(f, UInt64, 3)

		# Allocate Graph
		graph = MultiGraphs.MultiGraph(Label, AtomicEdge)
		MultiGraphs.sizehint!(graph, v_cnt, e_cnt)
		sizehint!(vertex_map, floor(UInt32, 1.5 * v_cnt))

		# Read Vertices
		for i in range(1, v_cnt)
			(label, parent, child_cnt) = read(f, UInt64, 3)
			children = read(f, UInt64, child_cnt)
			MultiGraphs.add_vertex!(graph, label)
			vertex_map[label] = Vertex(label, parent, children)
		end

		# Read EdgeMap
		sizehint!(edge_map, e_cnt)
		for i in range(1, e_cnt)
			(u, v, atomic_edge_cnt) = read(f, UInt64, 3)
			atomic_edges = read(f, AtomicEdge, atomic_edge_cnt)
			MultiGraphs.add_edges!(graph, u, v, atomic_edges)
		end

		close(f)
		# println("done.")
	catch e
		# println("failed: $e")
		return nothing
	end

	return Chunk(G, id, vertex_map, graph, max_label)
end

function get_vertex(g::ChunkedGraph, label::Label)
	return get_chunk(g,chunk_id(label)).vertices[label]
end

function lcG(G::ChunkedGraph, v1::Vertex, v2::Vertex)
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

function promote!(G::ChunkedGraph, v::Vertex)
	"""
	TODO check we don't call this over max height
	"""
	# println("promoting $v")
	c=get_chunk(G,chunk_id(v))

	@assert c.clean
	@assert v.parent == NULL_LABEL
	@assert length(MultiGraphs.incident_edges(c.graph,v.label))==0
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

function is_leaf(x::Vertex)
	return level(x)==1
end

function leaves(G::ChunkedGraph, v::Vertex)
	if is_leaf(v)
		return [v.label]
	elseif level(v)==2
		return v.children
	else
		return cat(1,map(x->leaves(G,get_vertex(G,x)),v.children)...)
	end
end

function leaves(G::ChunkedGraph, v::Vertex, l::Integer)
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

function leaves(G::ChunkedGraph, v::Vertex, cuboid::Cuboid)
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

function induced_subgraph{T<:Integer}(G::ChunkedGraph, chunk::Chunk, vertices::Vector{Label}, cuboid::Tuple{UnitRange{T},UnitRange{T},UnitRange{T}})
	atomic_edges = AtomicEdge[]
	chunks = [chunk];
	lvl = level(first(chunks))
	while lvl > 0
		# Add all induced_edges of all important vertices in all chunks on the current level to the existing list of atomic_edges
		append!(atomic_edges, vcat([vcat(values(MultiGraphs.induced_edges(c.graph, vertices))...) for c in chunks]...));

		if lvl > 1
			# From the current set of vertices, collect all child vertices
			vertices = vcat([vcat([c.vertices[v].children for v in filter(v->haskey(c.vertices, v), vertices)]...) for c in chunks]...);

			# Make sure we got all the necessary chunks in memory
			foreach(v->get_chunk(G, chunk_id(v)), vertices)

			# From the current set of chunks, collect all child chunks that still lie within the cuboid ROI
			chunks = filter(subc->overlaps(to_cuboid(chunk_id(subc)), cuboid), vcat([c.subgraphs for c in chunks]...))
		end
		lvl -= 1
	end

	atomic_vertices = Set(vertices)
	return collect(atomic_vertices), filter(e->e.u in atomic_vertices && e.v in atomic_vertices, atomic_edges)
end

import LightGraphs

function bounding_box(labels::Vector{UInt64})
	MAX_INT = 100000

	min_x, min_y, min_z = MAX_INT, MAX_INT, MAX_INT
	max_x, max_y, max_z = 0,0,0
	for l in labels
		@assert level(chunk_id(l))==1
		x,y,z = pos(chunk_id(l))
		min_x = min(min_x,x); max_x =  max(max_x,x)
		min_y = min(min_y,y); max_y =  max(max_y,y)
		min_z = min(min_z,z); max_z =  max(max_z,z)
	end
	return (min_x-2: max_x+2,
					min_y-2: max_y+2,
					min_z-2: max_z+2)

end

function min_cut(G::ChunkedGraph, source::UInt64, sink::UInt64)
	#make sure sources and sinks is a list
	#otherwise convert into a list
	return min_cut(G, Vector{UInt64}([source]), Vector{UInt64}([sink]))
end
function min_cut(G::ChunkedGraph, sources::Vector{UInt64}, sinks::Vector{UInt64})
	#=
	Returns a list of edges to cut
	=#
	INF_CAPACITY = typemax(Affinity)

	# DISCUSSION:
	# The connection between sources and sinks can lie outside bounding box, erroneously returning "no cut"
	# Not limiting the search region obviously leads to a considerable slowdown for huge objects, but it returns
	# correct results.
	bbox = (0:typemax(UInt64), 0:typemax(UInt64), 0:typemax(UInt64)) # bounding_box(vcat(sources,sinks))
	root_vertices = common_parent_vertices(G, vcat(sources, sinks))
	chunk = get_chunk(G, chunk_id(root_vertices[1].label))
	atomic_vertices, atomic_edges = induced_subgraph(G, chunk, map(r->r.label, root_vertices), bbox)

	# Relabel atomic vertices to get a dense matrix for LightGraphs
	encode=Dict()
	for (i,v) in enumerate(atomic_vertices)
		encode[v]=i
	end

	N=length(atomic_vertices)
	fake_source = N+1
	fake_sink = N+2
	N += 2
	flow_graph = LightGraphs.DiGraph(N)
	capacities = zeros(Affinity, (N,N))
	for atomic_edge in atomic_edges
		u = atomic_edge.u
		v = atomic_edge.v
		affinity = atomic_edge.aff

		LightGraphs.add_edge!(flow_graph,encode[u],encode[v])
		LightGraphs.add_edge!(flow_graph,encode[v],encode[u])

		# Don't split supervoxels at chunk boundaries
		# FIXME: this hack only works because seg_id are currently unique
		# across the whole dataset
		capacities[encode[u],encode[v]] = seg_id(u) == seg_id(v) ? INF_CAPACITY : affinity 
		capacities[encode[v],encode[u]] = seg_id(u) == seg_id(v) ? INF_CAPACITY : affinity
	end

	# create a fake source and add edges with infinite weight to all sources
	for source in sources
		LightGraphs.add_edge!(flow_graph , encode[source], fake_source)
		LightGraphs.add_edge!(flow_graph , fake_source, encode[source])

		capacities[encode[source], fake_source] = INF_CAPACITY
		capacities[fake_source, encode[source]] = INF_CAPACITY
	end

	# create a fake sink
	for sink in sinks
		LightGraphs.add_edge!(flow_graph , encode[sink], fake_sink)
		LightGraphs.add_edge!(flow_graph , fake_sink, encode[sink])

		capacities[encode[sink], fake_sink] = INF_CAPACITY
		capacities[fake_sink, encode[sink]] = INF_CAPACITY
	end

	f, _, labels = LightGraphs.multiroute_flow(
		flow_graph, fake_source, fake_sink, capacities,
		flow_algorithm = LightGraphs.BoykovKolmogorovAlgorithm(),
		routes=1)

	# No split found, or no split allowed
	if f < 0.00001 || f == INF_CAPACITY
		return AtomicEdge[]
	end

	# labels contains either 1,2 or 0
	# 1 means that the vertex in position i
	# should be part of the source
	# 2 means that it should be part of the sink
	# 0 means that it could be either 1 or 2
	# We will transform all 0 to 1, so that this function always
	# return two parts
	labels = map(x-> x == 0? 1 : x, labels)
	edges_to_cut = filter(e->labels[encode[e.u]] != labels[encode[e.v]], atomic_edges)
	
	# DISCUSSION:
	# We connected sinks and sources each by using a fake source/sink.
	# It is possible that real sources/sinks become disconnected after
	# cutting these edges - or already were disconnected in the beginning.
	# Should we create edges between all sinks and sources, respectively?
	return edges_to_cut
end

function is_root(v::Vertex)
	return v.parent == NULL_LABEL
end

function root(G::ChunkedGraph, x::Vertex)
	if is_root(x)
		return x
	else
		return root(G,get_vertex(G,x.parent))
	end
end

#####Graph operations#####

n_processed=0
function update!(c::ChunkedGraph)
	global n_processed
	n_processed = 0
	gc_enable(false)
	update!(get_chunk(c,TOP_ID))
	# println("updated")
	gc_enable(true)

end


function print_chunk_id(x::ChunkID)
	println("$(level(x)), $(map(Int,pos(x)))")
end


function update!(c::Chunk)
	if c.clean
		return
	end

	#Update children first
	for s in c.subgraphs
		update!(s)
	end

	#Print debug messages
	# println("updating $(level(c.id)), $(map(Int,pos(c.id))) V: +$(length(c.added_vertices))/-$(length(c.deleted_vertices)), E: +$(length(c.added_edges))/-$(length(c.deleted_edges))")
	global n_processed
	n_processed+=1
	# println("$n_processed/$(length(c.chunked_graph.graphs))")

	#vertices which need updates
	dirty_vertices=Set{Vertex}()


	# FIXME: We should upsize with the difference of added minus deleted
	upsize!(c.graph, length(c.added_vertices), length(c.added_edges))
	upsize!(c.vertices, length(c.added_vertices))

	# Insert added vertices
	# mark them as dirty_vertices as well
	for v in c.added_vertices
		@assert chunk_id(v) == c.id
		@assert v.parent == NULL_LABEL
		@assert !haskey(c.vertices, v.label)
		MultiGraphs.add_vertex!(c.graph, v.label)
		c.vertices[v.label]=v
		push!(dirty_vertices,v)
	end

	# Delete all vertices and marked the vertices connected to 
	# the one we are deleting as dirty
	for v in c.deleted_vertices
		# for child in v.children
		#	@assert get_vertex(c.chunked_graph,child).parent==NULL_LABEL
		# end

		for e in MultiGraphs.incident_edges(c.graph, v.label)
			if !in(e.u, c.deleted_vertices) || !in(e.v, c.deleted_vertices)
				push!(c.added_edges, e)
			end
		end

		# this should delete all edges incident with v as well
		MultiGraphs.delete_vertex!(c.graph,v.label)
		delete!(c.vertices,v.label)
	end


	for e in c.deleted_edges
			u,v=lcG(c.chunked_graph, map(x->get_vertex(c.chunked_graph,x),(e.u, e.v))...)
			@assert chunk_id(u) == chunk_id(c)
			@assert chunk_id(v) == chunk_id(c)
			MultiGraphs.delete_edge!(c.graph,u.label,v.label,e)
			push!(dirty_vertices,u)
			push!(dirty_vertices,v)
	end

	for e in c.added_edges
		try
			u,v=lcG(c.chunked_graph, map(x->get_vertex(c.chunked_graph,x),(e.u, e.v))...)
			@assert chunk_id(u) == chunk_id(c)
			@assert chunk_id(v) == chunk_id(c)
			@assert haskey(c.vertices,u.label)
			@assert haskey(c.vertices,v.label)

			@assert haskey(c.graph.vertex_map,u.label)
			@assert haskey(c.graph.vertex_map,v.label)
			MultiGraphs.add_edge!(c.graph,u.label,v.label,e)
			push!(dirty_vertices,u)
			push!(dirty_vertices,v)
		catch #vertices might not exist anymore
		end
	end

	if !is_root(c)
		for v in chain(dirty_vertices, c.deleted_vertices)
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


function unique_label(chunk::Chunk)
	chunk.max_label+=1
	return Label(chunk.max_label,chunk.id)
end


function add_atomic_vertex!(G::ChunkedGraph, label::Label)
	@assert level(chunk_id(label))==1 "$(level(chunk_id(label))) == 1"
	s=get_chunk(G,chunk_id(label))::Chunk
	if haskey(s.vertices,label)
		return
	end

	# Create new vertex with no parent neither children
	v=Vertex(label, NULL_LABEL, NULL_LIST)
	push!(s.added_vertices, v)
	touch(s)
end

function add_atomic_edge!(G::ChunkedGraph, edge::AtomicEdge)
	c = get_chunk(G,lca(chunk_id(edge.u),chunk_id(edge.v)))
	push!(c.added_edges, unordered(edge))
	touch(c)
end

function add_atomic_edges!(G::ChunkedGraph, edges::Vector{AtomicEdge})
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

function upsize!(A::AbstractArray, n::Integer)
	sizehint!(A,length(A)+n)
end
function upsize!(A::Dict, n::Integer)
	sizehint!(A,length(A)+n)
end

function upsize!(G::MultiGraphs.MultiGraph, n_v::Integer, n_e::Integer)
	upsize!(G.vertex_map,n_v)
	upsize!(G.inverse_vertex_map,n_v)
	upsize!(G.g.fadjlist,n_v)
	upsize!(G.edge_map,n_e)
end

function add_atomic_vertices!(G::ChunkedGraph, vertices::Vector{Label})
	gc_enable(false)
	for (i,v) in enumerate(vertices)
		add_atomic_vertex!(G,v)
	end
	gc_enable(true)
end

function delete_atomic_edge!(G::ChunkedGraph, edge::AtomicEdge)
	s=get_chunk(G,lca(chunk_id(edge.u),chunk_id(edge.v)))

	push!(s.deleted_edges, unordered(edge))
	touch(s)
end


function bfs(G::ChunkedGraph, label::Label)
	#wrong
	return [root(G,get_vertex(G,label))]
end

end

