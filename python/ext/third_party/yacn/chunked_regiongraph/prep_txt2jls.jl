push!(LOAD_PATH, dirname(@__FILE__))
include("../pre/Save.jl")
include("tasks.jl")

using Save
using Requests

const edges = Set{Tuple{Label,Label}}()
const vertices = Set{Label}()

addprocs(16)

queued_slices = Vector{Tuple{UnitRange{Int64},UnitRange{Int64},UnitRange{Int64}}}()

map_chunks((10240:cx:65014, 7680:cy:43714, 0:cz:1001), 0, 1) do slices
  max_x = min(last(slices[1]), 65014)
  max_y = min(last(slices[2]), 43714)
  max_z = min(last(slices[3]), 1001)
  push!(queued_slices, (slices[1][1]:max_x, slices[2][1]:max_y, slices[3][1]:max_z));
end

total_size = length(queued_slices)
println("Collected $total_size slices.")

dl_edges = Vector{Any}()
dl_vertices = Vector{Any}()
for i = 1:100:total_size
  @sync begin
    dl_edges = Vector{Vector{Tuple{UInt64, UInt64}}}(100)
    dl_vertices = Vector{Vector{Tuple{UInt64, UInt64}}}(100)
    for j = 0:99
      @async begin
        dl_edges[j+1] = Vector{Tuple{UInt64, UInt64}}()
        dl_vertices[j+1] = Vector{UInt64}()
        if i + j <= total_size
          while true
            resp = Requests.get("https://storage.googleapis.com/neuroglancer/pinky40_v11/chunked_regiongraph/$(slices_to_str(queued_slices[i+j]))_edges.txt")
            if statuscode(resp) == 200
              dl_edges[j+1] = deserialize(IOBuffer(read(resp)))
              break
            end
            sleep(5)
          end
          while true
            resp = Requests.get("https://storage.googleapis.com/neuroglancer/pinky40_v11/chunked_regiongraph/$(slices_to_str(queued_slices[i+j]))_vertices.txt")))
            if statuscode(resp) == 200
              dl_vertices[j+1] = deserialize(IOBuffer(read(resp)))
              break
            end
            sleep(5)
          end
          println("$(i+j) / $total_size: $(slices_to_str(queued_slices[i+j]))")
        else
          println("$(i+j) / $total_size: failed")
        end
      end
    end
  end

  # eval_e = @parallel (vcat) for j = 1:100
  #   eval(parse(dl_edges[j]))
  # end
  # eval_v = @parallel (vcat) for j = 1:100
  #   eval(parse(dl_vertices[j]))
  # end

  for t in filter(x->x!=nothing, eval_e)
    push!(edges,t)
  end

  for t in filter(x->x!=nothing, eval_v)
    push!(vertices,t)
  end
end

println(size(collect(edges)))

Save.save("/ssd/chunked_edges.jls",edges)
Save.save("/ssd/chunked_vertices.jls",vertices)
