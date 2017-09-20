push!(LOAD_PATH, dirname(@__FILE__))
include("../pre/Save.jl")
include("./constants.jl")
using ChunkedGraphs2
using Save
using Utils
using Base.Test

function test_cases()
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
        # @test root(G, get_vertex(G, Utils.Label(1,0,0,1,3))) == root(G, get_vertex(G, Utils.Label(1,0,0,0,2)))

        add_atomic_edge!(G, (Utils.Label(1,0,0,0,2), Utils.Label(1,0,0,0,1)))
        update!(G)
        # print( root(G, get_vertex(G, Utils.Label(1,0,0,1,3))) )
        # print( root(G, get_vertex(G, Utils.Label(1,0,0,0,2))) )
        # @test root(G, get_vertex(G, Utils.Label(1,0,0,1,3))) == root(G, get_vertex(G, Utils.Label(1,0,0,0,2)))
        # @test root(G, get_vertex(G, Utils.Label(1,0,0,1,3))) == root(G, get_vertex(G, Utils.Label(1,0,0,0,1)))


    end

end
test_cases()