module MultiGraphs
using LightGraphs
using DataStructures

#todo: garbage collection

type MultiGraph
	g::LightGraphs.Graph
	vertex_map::Dict
	inverse_vertex_map::Dict
	edge_map::DefaultDict

	function MultiGraph()
		return new(LightGraphs.Graph(), Dict(),Dict(),DefaultDict(()->Set()))
	end
end
function add_vertex!(G::MultiGraph, v)
	LightGraphs.add_vertex!(G.g)
	G.vertex_map[v] = nv(G.g)
	G.inverse_vertex_map[nv(G.g)] = v
end

function delete_vertex!(G::MultiGraph,vertex)
	u=vertex_map[vertex]
	for v in neighbors(G.g,u)
		rem_edge!(G,u,v)
	end
	delete!(G.vertex_map,vertex)
end

function delete_edge!(G::MultiGraph,U,V,e)
	u=G.vertex_map[U]
	v=G.vertex_map[V]
	if has_edge(G.g,u,v)
		delete!(edge_map[(u,v)],e)
		if length(edge_map[(u,v)]) == 0
			rem_edge!(G.g,u,v)
		 end
	end
end

function add_edge!(G::MultiGraph,U,V,e)
	u=G.vertex_map[U]
	v=G.vertex_map[V]
	LightGraphs.add_edge!(G.g,u,v)
	push!(G.edge_map[(u,v)],e)
end

function connected_components(G::MultiGraph, Vertices)
	g=G.g
	vertices = map(x->G.vertex_map[x],Vertices)
	visited=Set()
	components=[]

	for v in vertices
		if !(v in visited)
			next_component=[]
			to_visit=Set([v])
			while length(to_visit) > 0
				x=pop!(to_visit)
				push!(next_component,x)
				push!(visited,x)
				for n in neighbors(g,x)
					if !(n in visited)
						push!(to_visit,n)
					end
				end
			end
			push!(components, next_component)
		end
	end
	return [map(x->G.inverse_vertex_map[x],y) for y in components]

end


end
