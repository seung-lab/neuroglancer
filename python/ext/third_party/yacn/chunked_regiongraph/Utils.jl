module Utils

export unordered, to_chunk_id, chunk_id_to_slices, str_to_slices, slices_to_str, ChunkID, Label, seg_id, chunk_id, level, pos

function unordered{T}(x::Tuple{T,T})
	a,b = x
	return (min(a,b),max(a,b))
end
function unordered{T}(a::T,b::T)
	return (min(a,b),max(a,b))
end


include("constants.jl")

#The first element represents level, the last three represent location
#typealias ChunkID Tuple{Int,Int,Int,Int}
typealias ChunkID UInt32
typealias Label UInt64

const low_mask_8 = UInt32(0b11111111)

function to_chunk_id(x,y,z)
	#todo: bounds check
	L=UInt32(1) & low_mask_8
	X=UInt32(fld(x,cx)) & low_mask_8
	Y=UInt32(fld(y,cy)) & low_mask_8
	Z=UInt32(fld(z,cz)) & low_mask_8
	return ChunkID(L,X,Y,Z)
end

function ChunkID(L::UInt32,X::UInt32,Y::UInt32,Z::UInt32)
	return (L << 24) | (X << 16) | (Y << 8) | Z
end

function ChunkID(L,X,Y,Z)
	return ChunkID(UInt32(L),UInt32(X),UInt32(Y),UInt32(Z))
end

function level(id::ChunkID)
	return ((id >> 24) & low_mask_8)
end

function pos(id::ChunkID)
	return (id >> 16) & low_mask_8, (id >> 8) & low_mask_8, id & low_mask_8
end

function Label(seg_id::UInt32, chunk_id::ChunkID)
	return (UInt64(seg_id)) | (UInt64(chunk_id) << 32)
end

function Label(x,y)
	return Label(UInt32(x),UInt32(y))
end

const low_mask_32 = UInt64(0b11111111111111111111111111111111)
function seg_id(l::Label)
	return UInt32(l & low_mask_32)
end

function chunk_id(l::Label)
	return UInt32((l >> 32) & low_mask_32)
end

function chunk_id_to_slices(chunk_id;low_pad=0, high_pad=0)
	l=level(chunk_id)
	x,y,z = pos(chunk_id)
	@assert l==1
	return ((x)*cx-low_pad:(x+1)*(cx)+high_pad,
		 	(y)*cy-low_pad:(y+1)*(cy)+high_pad,
			(z)*cz-low_pad:(z+1)*(cz)+high_pad)
end

function str_to_slices(s)
	m=match(r"(\d+)-(\d+)_(\d+)-(\d+)_(\d+)-(\d+)",s)
	bounds = map(x->parse(Int,x), m.captures)
	return (bounds[1]:bounds[2], bounds[3]:bounds[4], bounds[5]:bounds[6])
end

function slices_to_str(s)
	t=map(slice_to_str,s)
	return "$(t[1])_$(t[2])_$(t[3])"
end

function slice_to_str(s)
	return "$(s.start)-$(s.stop)"
end

end
