using ImageFiltering

function height_map{T}(aff::Array{T,4})
	ret = fill(zero(T), (size(aff,1),size(aff,2),size(aff,3)))
	@time for k in 1:size(aff,3), j in 1:size(aff,2), i in 2:size(aff,1)
		ret[i,j,k]=max(ret[i,j,k], aff[i,j,k,1])
		ret[i-1,j,k]=max(ret[i-1,j,k],aff[i,j,k,1])
	end
	@time for k in 1:size(aff,3), j in 2:size(aff,2), i in 2:size(aff,1)
		ret[i,j,k]=max(ret[i,j,k], aff[i,j,k,2])
		ret[i,j-1,k]=max(ret[i,j-1,k],aff[i,j,k,2])
	end
	@time for k in 2:size(aff,3), j in 1:size(aff,2), i in 1:size(aff,1)
		ret[i,j,k]=max(ret[i,j,k], aff[i,j,k,3])
		ret[i,j,k-1]=max(ret[i,j,k-1],aff[i,j,k,3])
	end
	return ret
end

function threshold!{T}(raw::Array{T,3}, h, t)
	for i in eachindex(raw,h)
		if h[i] < t
			raw[i]=zero(T)
		end
	end
end

function quantize{T,N}(x::Array{T,N})
	return round.(1024 .* x)./1024
end

function minfilter{T}(A::Array{T,3},n)
	B=fill(zero(T),size(A))
	for z in 1:size(A,3)
		B[:,:,z] = map(x->x[1],mapwindow(extrema,A[:,:,z],n))
	end
	return B
end
