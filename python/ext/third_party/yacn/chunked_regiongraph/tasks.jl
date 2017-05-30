using PyCall
using OffsetArrays
using Utils
@pyimport neuroglancer.pipeline as pl
const pyslice=pybuiltin(:slice)

include("constants.jl")

function chunked_labelling{T}(raw::OffsetArray{T,3})
	ret = OffsetArray(Label,indices(raw)...)
	for k in indices(raw,3)
		for j in indices(raw,2)
			for i in indices(raw,1)
				ret[i,j,k]=Label(raw[i,j,k],to_chunk_id(i,j,k))
			end
		end
	end
	println(typeof(ret))
	return ret
end

function drop_last(x::UnitRange)
	return x.start:x.stop-1
end
function compute_regiongraph{T,S}(raw::AbstractArray{T,3}, machine_labels::AbstractArray{S,3})
	edges = Set{Tuple{T,T}}()
	@time @inbounds for k in drop_last(indices(raw,3)), j in indices(raw,2), i in indices(raw,1)
		if raw[i,j,k] != raw[i,j,k+1] && machine_labels[i,j,k] == machine_labels[i,j,k+1]
			push!(edges,unordered(raw[i,j,k],raw[i,j,k+1]))
		end
	end
	@time @inbounds for k in indices(raw,3), j in drop_last(indices(raw,2)), i in indices(raw,1)
		if raw[i,j,k] != raw[i,j+1,k] && machine_labels[i,j,k] == machine_labels[i,j+1,k]
			push!(edges,unordered(raw[i,j,k],raw[i,j+1,k]))
		end
	end
	@time @inbounds for k in indices(raw,3), j in indices(raw,2), i in drop_last(indices(raw,1))
		if raw[i,j,k] != raw[i+1,j,k] && machine_labels[i,j,k] == machine_labels[i+1,j,k]
			push!(edges,unordered(raw[i+1,j,k],raw[i,j,k]))
		end
	end
	return collect(edges)
end

function cached(f)
	cache=Dict()
	function my_f(args...)
		if !haskey(cache, args)
			cache[args] = f(args...)
		else
			println("restoring from cache")
		end
		return cache[args]
	end
end
CachedStorage = cached(pl.Storage)

immutable PrecomputedWrapper
	val
	function PrecomputedWrapper(storage_string)
		return new(pl.Precomputed(CachedStorage(storage_string)))
	end
end

function Base.getindex(x::PrecomputedWrapper, slicex::UnitRange, slicey::UnitRange, slicez::UnitRange)
	return OffsetArray(
	squeeze(get(x.val, 
			(pyslice(slicex.start,slicex.stop+1),
			pyslice(slicey.start,slicey.stop+1),
			pyslice(slicez.start,slicez.stop+1))),4),
	slicex,slicey,slicez)

end

function edge_task(watershed_storage, segmentation_storage, output_storage, slices)
	watershed = PrecomputedWrapper(watershed_storage)
	watershed_cutout = watershed[slices...]

	segmentation = PrecomputedWrapper(segmentation_storage)
	segmentation_cutout = segmentation[slices...]

	relabelled = chunked_labelling(watershed_cutout)
	edges = compute_regiongraph(relabelled,segmentation_cutout)
	vertices = unique(relabelled)
	
	output_storage = pl.Storage(output_storage)
	output_storage[:put_file](file_path="$(slices_to_str(slices))_edges.txt", content="$(edges)")
	output_storage[:put_file](file_path="$(slices_to_str(slices))_vertices.txt", content="$(vertices)")
	output_storage[:wait]()
end

function map_chunks(f, ranges, low_overlap, high_overlap)
	s1,s2,s3=map(x->x.step,ranges)
	for r1 in ranges[1], r2 in ranges[2], r3 in ranges[3]
		slices=(r1-low_overlap:r1+s1+high_overlap, 
		r2-low_overlap:r2+s2+high_overlap, 
		r3-low_overlap:r3+s3+high_overlap)
		println(slices)
		f(slices)
	end
end

