module Utils
include("constants.jl")
export unordered, to_chunk_id, chunk_id_to_slices, str_to_slices, slices_to_str, ChunkID, Label, Affinity, AtomicEdge, seg_id, chunk_id, level, pos

#The first element represents level, the last three represent location
#typealias ChunkID Tuple{Int,Int,Int,Int}
typealias ChunkID UInt32
typealias Label UInt64
typealias Affinity Float32

type AtomicEdge
	u::Label
	v::Label
	aff::Affinity
end
function AtomicEdge(u::Label, v::Label)
	return AtomicEdge(u, v, 1.f0)
end
function AtomicEdge(a::Tuple{Label, Label, Affinity})
	return AtomicEdge(a[1], a[2], a[3])
end

Base.isless(x::AtomicEdge,y::AtomicEdge) = isequal(x.u, y.u) ? x.v < y.v : x.u < y.u
Base.:(<)(x::AtomicEdge,y::AtomicEdge) = isless(x,y)
Base.:(==)(x::AtomicEdge,y::AtomicEdge) = isequal(x.u, y.u) && isequal(x.v, y.v)
Base.hash(x::AtomicEdge, h::UInt) = hash(x.u, hash(x.v, hash(:AtomicEdge, h)))
Base.write(s::IO, x::AtomicEdge) = unsafe_write(s, Ptr{AtomicEdge}(pointer_from_objref(x)), sizeof(AtomicEdge))
Base.read(s::IO, t::Type{AtomicEdge}) = begin
	ret = AtomicEdge(0, 0, 0.f0)
	unsafe_read(s, pointer_from_objref(ret), sizeof(AtomicEdge))
	return ret
end
Base.read(s::IO, a::Array{AtomicEdge}) = begin
	for i in eachindex(a)
		a[i] = read(s, AtomicEdge)
	end
	return a
end
Base.read(s::IO, t::Type{AtomicEdge}, dims::Dims) = read(s, Array{AtomicEdge}(dims))

function unordered(x::AtomicEdge)
	return AtomicEdge(min(x.u,x.v), max(x.u,x.v), x.aff)
end

function unordered{T<:Integer}(x::Tuple{T,T})
	a,b = x
	return (min(a,b), max(a,b))::Tuple{T,T}
end
function unordered{T<:Integer}(a::T,b::T)
	return (min(a,b), max(a,b))::Tuple{T,T}
end

const low_mask_8 = UInt32(0b11111111)

function to_chunk_id(x,y,z)
	#todo: bounds check
	L=UInt32(1) & low_mask_8
	X=UInt32(fld(x,cx)) & low_mask_8
	Y=UInt32(fld(y,cy)) & low_mask_8
	Z=UInt32(fld(z,cz)) & low_mask_8
	return ChunkID(L,X,Y,Z)
end

@inline function ChunkID(L::UInt32,X::UInt32,Y::UInt32,Z::UInt32)
	return (L << 24) | (X << 16) | (Y << 8) | Z
end

@inline function ChunkID(L,X,Y,Z)
	return ChunkID(UInt32(L),UInt32(X),UInt32(Y),UInt32(Z))
end

@inline function level(id::ChunkID)
	return ((id >> 24) & low_mask_8)
end

@inline function pos(id::ChunkID)
	return (id >> 16) & low_mask_8, (id >> 8) & low_mask_8, id & low_mask_8
end

@inline function Label(seg_id::UInt32, chunk_id::ChunkID)
	return (UInt64(seg_id)) | (UInt64(chunk_id) << 32)
end

@inline function Label(level, x, y, z, seg_id)
	return Label(seg_id, ChunkID(level, x, y, z))
end

@inline function Label(x,y)
	return Label(UInt32(x),UInt32(y))
end

const low_mask_32 = UInt64(0b11111111111111111111111111111111)
@inline function seg_id(l::Label)
	return UInt32(l & low_mask_32)
end

@inline function chunk_id(l::Label)
	return UInt32((l >> 32) & low_mask_32)
end

function chunk_id_to_slices(chunk_id;low_pad=0, high_pad=0)
	l=level(chunk_id)
	x,y,z = pos(chunk_id)
	@assert l>=1
	chunk_size_x = 2^(l-1) * cx
	chunk_size_y = 2^(l-1) * cy
	chunk_size_z = 2^(l-1) * cz
	return ((x)*chunk_size_x-low_pad:(x+1)*(chunk_size_x)+high_pad,
		 	(y)*chunk_size_y-low_pad:(y+1)*(chunk_size_y)+high_pad,
			(z)*chunk_size_z-low_pad:(z+1)*(chunk_size_z)+high_pad)
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
