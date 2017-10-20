module SegmentPicking
export get_supervoxel_at

using ChunkedGraphs2
using Utils

# Get the supervoxel id closest to `voxel_pos` that is a leaf of `start_label`
function get_supervoxel_at(G::ChunkedGraph, start_label::Label, voxel_pos::Tuple{Int, Int, Int})
	if Utils.chunk_id(start_label) == 0
		start_label = Utils.Label(Utils.seg_id(start_label), Utils.to_chunk_id(voxel_pos[1], voxel_pos[2], voxel_pos[3]))
		# FIXME: If we deal with very coarse supervoxel meshes near chunk boundaries, the picked position might lie within
		#        the neighboring chunk which doesn't contain the supervoxel
	end

	const root_vertex = ChunkedGraphs2.root(G, ChunkedGraphs2.get_vertex(G, start_label))

	const padding = CartesianIndex(16,16,2)
	const voxel_res = Vector{Int}(G.cloudvolume.val[:scale]["resolution"])
	const cutout_range = voxel_pos[1]-padding[1] : voxel_pos[1]+padding[1], voxel_pos[2]-padding[2] : voxel_pos[2]+padding[2], voxel_pos[3]-padding[3] : voxel_pos[3]+padding[3]

	const segmentation_ids = G.cloudvolume[cutout_range...]::Array{UInt32, 3} # <-- slow, even when cached
	const world_positions = collect(CartesianRange(cutout_range))

	const sortkey = sortperm(collect(Base.flatten(
		map(i->(voxel_res[1] * (i[1] - padding[1] - 1))^2 + (voxel_res[2] * (i[2] - padding[2] - 1))^2 + (voxel_res[3] * (i[3] - padding[3] - 1))^2,
				CartesianRange(size(segmentation_ids))
		)
	)))

	const already_checked = Set{Int}()
	for i in sortkey
		if segmentation_ids[i] == 0 || segmentation_ids[i] in already_checked
			continue
		end

		segid = segmentation_ids[i]
		worldpos = world_positions[i]
		chunkid = Utils.to_chunk_id(worldpos[1], worldpos[2], worldpos[3])
		labelid = Utils.Label(segid, chunkid)

		if ChunkedGraphs2.root(G, ChunkedGraphs2.get_vertex(G, labelid)) == root_vertex
			return labelid
		end

		push!(already_checked, segid)
	end

	return nothing
end
end
