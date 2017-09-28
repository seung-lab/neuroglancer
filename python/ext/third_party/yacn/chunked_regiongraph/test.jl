push!(LOAD_PATH, dirname(@__FILE__))
include("../pre/Save.jl")
include("./constants.jl")
using ChunkedGraphs2
using Save
using Utils
using Base.Test
using LightGraphs

function test_cases()
	@testset "all_tests" begin

		@testset "add test_add_atomic_node" begin
			G = ChunkedGraph("/tmp/graph")
			label = Utils.Label(1,0,0,0,1)
			add_atomic_vertex!(G, label)
			update!(G)
			@test get_vertex(G, label) == ChunkedGraphs2.Vertex(label, 
				ChunkedGraphs2.NULL_LABEL, 
				ChunkedGraphs2.NULL_LIST)

			@test_throws KeyError get_vertex(G, Utils.Label(1,0,0,0,2))
		end

		@testset "test_circle" begin
			G = ChunkedGraph("/tmp/graph")
			add_atomic_vertex!(G, Utils.Label(1,0,0,0,3))
			add_atomic_vertex!(G, Utils.Label(1,0,0,0,2))
			add_atomic_vertex!(G, Utils.Label(1,0,0,0,1))
			update!(G)

			add_atomic_edge!(G, (Utils.Label(1,0,0,0,1), Utils.Label(1,0,0,0,2)))
			add_atomic_edge!(G, (Utils.Label(1,0,0,0,1), Utils.Label(1,0,0,0,3)))
			add_atomic_edge!(G, (Utils.Label(1,0,0,0,2), Utils.Label(1,0,0,0,3)))
			update!(G)

			@test get_vertex(G, Utils.Label(1,0,0,0,1)).parent == get_vertex(G, Utils.Label(1,0,0,0,2)).parent
			@test get_vertex(G, Utils.Label(1,0,0,0,2)).parent == get_vertex(G, Utils.Label(1,0,0,0,3)).parent
		end

		@testset "test_circle_external_edge" begin
			G = ChunkedGraph("/tmp/graph")
			add_atomic_vertex!(G, Utils.Label(1,0,0,1,3))
			add_atomic_vertex!(G, Utils.Label(1,0,0,0,2))
			add_atomic_vertex!(G, Utils.Label(1,0,0,0,1))

			add_atomic_edge!(G, (Utils.Label(1,0,0,1,3), Utils.Label(1,0,0,0,2)))
			update!(G)
			add_atomic_edge!(G, (Utils.Label(1,0,0,0,2), Utils.Label(1,0,0,0,1)))
			update!(G)
			@test root(G, get_vertex(G, Utils.Label(1,0,0,1,3))) == root(G, get_vertex(G, Utils.Label(1,0,0,0,2)))
			@test root(G, get_vertex(G, Utils.Label(1,0,0,1,3))) == root(G, get_vertex(G, Utils.Label(1,0,0,0,1)))
		end

		@testset "test_circle_external_edge" begin
			G = ChunkedGraph("/tmp/graph")
			add_atomic_vertex!(G, Utils.Label(1,0,0,1,3))
			add_atomic_vertex!(G, Utils.Label(1,0,0,0,2))
			add_atomic_vertex!(G, Utils.Label(1,0,0,0,1))

			add_atomic_edge!(G, (Utils.Label(1,0,0,1,3), Utils.Label(1,0,0,0,2)))
			update!(G)
			add_atomic_edge!(G, (Utils.Label(1,0,0,0,2), Utils.Label(1,0,0,0,1)))
			update!(G)
			@test root(G, get_vertex(G, Utils.Label(1,0,0,1,3))) == root(G, get_vertex(G, Utils.Label(1,0,0,0,2)))
			@test root(G, get_vertex(G, Utils.Label(1,0,0,1,3))) == root(G, get_vertex(G, Utils.Label(1,0,0,0,1)))
		end

		# @testset "deleted_node" begin
		#     G = ChunkedGraph("/tmp/graph")
		#     label = Utils.Label(1,0,0,0, 1)
		#     add_atomic_vertex!(G, label )
		#     update!(G)
		#     delete_atomic_vertex!(G, label)
		#     update!(G)
		#     @test_throws KeyError get_vertex(G, label)
		#     add_atomic_vertex!(G, label)
		#     update!(G)
		#     @test get_vertex(G, label) == ChunkedGraphs2.Vertex(label, 
		#         ChunkedGraphs2.NULL_LABEL, 
		#         ChunkedGraphs2.NULL_LIST)
		# end

		# @testset "deleted_node_fusion" begin
		#     G = ChunkedGraph("/tmp/graph")
		#     label = Utils.Label(1,0,0,0, 1)
		#     add_atomic_vertex!(G, label )
		#     @test_throws KeyError delete_atomic_vertex!(G, label)
		#     update!(G)
		# end

		@testset "delete_edge_same_chunk" begin
			G = ChunkedGraph("/tmp/graph")
			add_atomic_vertex!(G, Utils.Label(1,0,0,0, 1) )
			add_atomic_vertex!(G, Utils.Label(1,0,0,0, 2) )
			add_atomic_edge!(G, (Utils.Label(1,0,0,0,1), Utils.Label(1,0,0,0,2)))
			update!(G)
			@test root(G, get_vertex(G, Utils.Label(1,0,0,0,1))) == root(G, get_vertex(G, Utils.Label(1,0,0,0,2)))

			delete_atomic_edge!(G, (Utils.Label(1,0,0,0,1), Utils.Label(1,0,0,0,2)))
			update!(G)
			@test root(G, get_vertex(G, Utils.Label(1,0,0,0,1))) != root(G, get_vertex(G, Utils.Label(1,0,0,0,2)))
		end

		@testset "delete_edge_different_chunk" begin
			G = ChunkedGraph("/tmp/graph")
			u = Utils.Label(1,0,0,0,1)
			v = Utils.Label(1,0,0,1,2)
			add_atomic_vertex!(G, u)
			add_atomic_vertex!(G, v)
			add_atomic_edge!(G, (u,v))
			update!(G)
			@test root(G, get_vertex(G,u)) == root(G, get_vertex(G,v))

			delete_atomic_edge!(G, (u,v))
			update!(G)
			@test root(G, get_vertex(G,u)) != root(G, get_vertex(G,v))
			@test length(root(G, get_vertex(G, u)).children) == 1
			@test length(root(G, get_vertex(G, v)).children) == 1
		end

		@testset "test_3_node_delete" begin
			G = ChunkedGraph("/tmp/graph")
			add_atomic_vertex!(G, Utils.Label(1,0,0,0,1) )
			add_atomic_vertex!(G, Utils.Label(1,0,0,1,2) )
			add_atomic_vertex!(G, Utils.Label(1,0,0,3,3) )

			add_atomic_edge!(G, (Utils.Label(1,0,0,0,1), Utils.Label(1,0,0,1,2)))
			add_atomic_edge!(G, (Utils.Label(1,0,0,1,2), Utils.Label(1,0,0,3,3)))
			update!(G)

			delete_atomic_edge!(G, (Utils.Label(1,0,0,0,1), Utils.Label(1,0,0,1,2)))
			update!(G)
			@test root(G, get_vertex(G, Utils.Label(1,0,0,0,1))) != root(G, get_vertex(G, Utils.Label(1,0,0,1,2)))
			@test root(G, get_vertex(G, Utils.Label(1,0,0,1,2))) == root(G, get_vertex(G, Utils.Label(1,0,0,3,3)))

			@test length(root(G, get_vertex(G, Utils.Label(1,0,0,0,1))).children) == 1
		end


		@testset "two_node_min_cut" begin
			G = ChunkedGraph("/tmp/graph")
			u = Utils.Label(1,0,0,0,1)
			v = Utils.Label(1,0,0,0,2)

			add_atomic_vertex!(G, u )
			add_atomic_vertex!(G, v )

			add_atomic_edge!(G, (u, v))

			update!(G)
			@test Set(min_cut(G, u, v)) == Set([(u,v)])

			println(min_cut(G, u, u))
			# @test_throws KeyError min_cut(G, v, v)
			@test_throws KeyError min_cut(G, u, Utils.Label(1,0,0,0,3))
			@test_throws KeyError min_cut(G, u, Utils.Label(1,0,0,5,1))
		end


		@testset "triangle_min_cut" begin
			G = ChunkedGraph("/tmp/graph")
			u = Utils.Label(1,0,0,0,1)
			v = Utils.Label(1,0,0,0,2)
			w = Utils.Label(1,0,0,0,3)

			add_atomic_vertex!(G, u )
			add_atomic_vertex!(G, v )
			add_atomic_vertex!(G, w )

			add_atomic_edge!(G, (u, v))
			add_atomic_edge!(G, (u, w))
			add_atomic_edge!(G, (v, w))

			update!(G)

			@test Set(min_cut(G, u, v)) == Set([(u,v),(v,w)])
			@test Set(min_cut(G, [u,w], [v])) == Set([(u,v),(v,w)])
			@test Set(min_cut(G, [u], [v,w])) == Set([(u,v),(u,w)])
		end

		@testset "chunk_min_cut" begin
			G = ChunkedGraph("/tmp/graph")
			u = Utils.Label(1,0,0,0,1)
			v = Utils.Label(1,0,0,0,2)
			w = Utils.Label(1,0,0,1,3)

			add_atomic_vertex!(G, u )
			add_atomic_vertex!(G, v )
			add_atomic_vertex!(G, w )

			add_atomic_edge!(G, (u, v))
			add_atomic_edge!(G, (u, w))
			add_atomic_edge!(G, (v, w))

			update!(G)

			@test Set(min_cut(G, u, v)) == Set([(u,v),(v,w)])
			@test Set(min_cut(G, [u,w], [v])) == Set([(u,v),(v,w)])
			@test Set(min_cut(G, [u], [v,w])) == Set([(u,v),(u,w)])
		end

		@testset "multi_split" begin
			# Two triangles connected over a small bridge (x1-x2)
			G = ChunkedGraph("/tmp/graph")
			a1 = Utils.Label(1,0,0,0,1)
			a2 = Utils.Label(1,0,0,0,2)
			x1 = Utils.Label(1,0,0,0,3)
			x2 = Utils.Label(1,0,0,0,4)
			b1 = Utils.Label(1,0,0,0,5)
			b2 = Utils.Label(1,0,0,0,6)

			add_atomic_vertex!(G, a1 )
			add_atomic_vertex!(G, a2 )
			add_atomic_vertex!(G, x1 )
			add_atomic_vertex!(G, x2 )
			add_atomic_vertex!(G, b1 )
			add_atomic_vertex!(G, b2 )

			add_atomic_edge!(G, (a1, a2))
			add_atomic_edge!(G, (a1, x1))
			add_atomic_edge!(G, (a2, x1))
			add_atomic_edge!(G, (x1, x2))
			add_atomic_edge!(G, (x2, b1))
			add_atomic_edge!(G, (x2, b2))
			add_atomic_edge!(G, (b1, b2))

			update!(G)

			@test Set(min_cut(G, [a1,a2], [b1])) == Set([(x1,x2)])
			@test Set(min_cut(G, [a1,b1], [b2])) == Set([(x2,b2),(b1,b2)])
			@test Set(min_cut(G, [a1,b1], [a2,b2])) == Set([(a1,a2),(b1,b2),(a2,x1),(x2,b2)])
		end

		@testset "multi_split_omni" begin
			#= Copied from Omni
			* Reference trinary tree diagram for the following tests
			* Labelled Using vertex INDEX NOT segID
			*                                         1
			*                                         ^
			*               /                         |                         \
			*              2                          3                          4
			*              ^                          ^                          ^
			*      /       |       \          /       |       \          /       |       \
			*     5        6        7        8        9       10        11      12       13
			*     ^        ^        ^        ^        ^        ^        ^        ^        ^
			*   / |  \   / |  \   / |  \   / |  \   / |  \   / |  \   / |  \   / |  \   / |  \
			*  14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 39 40
			=#
			G = ChunkedGraph("/tmp/graph")
			v = map(x->Utils.Label(1,0,0,0,x), 1:40)
			for vertex in v
				add_atomic_vertex!(G, vertex)
			end

			for i=1:13
				add_atomic_edge!(G, (v[i], v[3*i-1]))
				add_atomic_edge!(G, (v[i], v[3*i]))
				add_atomic_edge!(G, (v[i], v[3*i+1]))
			end

			update!(G)

			@test Set(min_cut(G, [v[17], v[6], v[3]], [v[18], v[4], v[12]])) == Set([(v[1],v[4]),(v[6], v[18])])
		end

		@testset "supervoxels_not_splitted" begin
			#=
			Currently are datasets have unique
			supervoxels
			this means seg_id (the first 32bits of a label)
			are unique.

			We will need to remove this limitation eventually
			but for now, we will make sure we won't split 
			supervoxels with same seg id
			=#

			G = ChunkedGraph("/tmp/graph")
			u = Utils.Label(1,0,0,0,1)
			v = Utils.Label(1,0,0,1,1)
			add_atomic_vertex!(G, u )
			add_atomic_vertex!(G, v )
			add_atomic_edge!(G, (u, v))
			update!(G)

			@test isempty(min_cut(G, u, v))
		end
	end

end

test_cases()
