push!(LOAD_PATH, dirname(@__FILE__))
include("../pre/Save.jl")
include("./constants.jl")
using ChunkedGraphs2
using Save
using Utils
using Base.Test

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

        @testset "deleted_node" begin
            G = ChunkedGraph("/tmp/graph")
            label = Utils.Label(1,0,0,0, 1)
            add_atomic_vertex!(G, label )
            update!(G)
            delete_atomic_vertex!(G, label)
            update!(G)
            @test_throws KeyError get_vertex(G, label)
            add_atomic_vertex!(G, label)
            update!(G)
            @test get_vertex(G, label) == ChunkedGraphs2.Vertex(label, 
                ChunkedGraphs2.NULL_LABEL, 
                ChunkedGraphs2.NULL_LIST)
        end

        @testset "deleted_node_fusion" begin
            G = ChunkedGraph("/tmp/graph")
            label = Utils.Label(1,0,0,0, 1)
            add_atomic_vertex!(G, label )
            @test_throws KeyError delete_atomic_vertex!(G, label)
            update!(G)
        end

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
            add_atomic_vertex!(G, Utils.Label(1,0,0,0, 1) )
            add_atomic_vertex!(G, Utils.Label(1,0,0,1, 2) )
            add_atomic_edge!(G, (Utils.Label(1,0,0,0,1), Utils.Label(1,0,0,1,2)))
            update!(G)
            @test root(G, get_vertex(G, Utils.Label(1,0,0,0,1))) == root(G, get_vertex(G, Utils.Label(1,0,0,1,2)))

            delete_atomic_edge!(G, (Utils.Label(1,0,0,0,1), Utils.Label(1,0,0,1,2)))
            update!(G)
            @test root(G, get_vertex(G, Utils.Label(1,0,0,0,1))) != root(G, get_vertex(G, Utils.Label(1,0,0,1,2)))
            @test length(root(G, get_vertex(G, Utils.Label(1,0,0,0,1))).children) == 1
            @test length(root(G, get_vertex(G, Utils.Label(1,0,0,1,2))).children) == 1

        end

        @testset "test_delete_vertex_with_edge_same_chunk" begin
            G = ChunkedGraph("/tmp/graph")
            add_atomic_vertex!(G, Utils.Label(1,0,0,0, 1) )
            add_atomic_vertex!(G, Utils.Label(1,0,0,0, 2) )
            add_atomic_edge!(G, (Utils.Label(1,0,0,0,1), Utils.Label(1,0,0,0,2)))
            update!(G)

            delete_atomic_vertex!(G, Utils.Label(1,0,0,0, 1))
            update!(G)
            @test length(root(G, get_vertex(G, Utils.Label(1,0,0,0,1))).children) == 1
        end

        @testset "test_delete_vertex_with_edge_adjacent_chunk" begin
            G = ChunkedGraph("/tmp/graph")
            add_atomic_vertex!(G, Utils.Label(1,0,0,0,1) )
            add_atomic_vertex!(G, Utils.Label(1,0,0,1,2) )
            add_atomic_edge!(G, (Utils.Label(1,0,0,0,1), Utils.Label(1,0,0,1,2)))
            update!(G)

            delete_atomic_vertex!(G, Utils.Label(1,0,0,0, 1))
            update!(G)
            @test length(root(G, get_vertex(G, Utils.Label(1,0,0,0,1))).children) == 1
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
    end


end
test_cases()