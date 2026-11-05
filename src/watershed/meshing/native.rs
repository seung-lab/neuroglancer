// MIT: extraction adapted from Will Usher's pinned implementation; see README.md.
// The table, corner/edge numbering, and interpolation are included unchanged.
include!(env!("MC_CORE_RS"));

const MAX_VOXELS: usize = 1 << 21;
const MAX_TRIANGLES: usize = 1 << 18;

#[no_mangle]
pub extern "C" fn mc_alloc(bytes: usize) -> *mut u8 {
    if bytes == 0 || bytes > MAX_TRIANGLES * 9 * 4 {
        return std::ptr::null_mut();
    }
    let layout = std::alloc::Layout::from_size_align(bytes, 4).unwrap();
    unsafe { std::alloc::alloc(layout) }
}

#[no_mangle]
pub unsafe extern "C" fn mc_free(pointer: *mut u8, bytes: usize) {
    if !pointer.is_null() {
        std::alloc::dealloc(pointer, std::alloc::Layout::from_size_align(bytes, 4).unwrap());
    }
}

// Caller owns valid input/output allocations. No allocation occurs during extraction.
// Returns the float count, or -1 for invalid input, -2 for insufficient output capacity.
#[no_mangle]
pub unsafe extern "C" fn mc_extract(
    mask: *const u8,
    mask_length: usize,
    x: usize,
    y: usize,
    z: usize,
    output: *mut f32,
    output_floats: usize,
) -> i32 {
    let voxels = x.checked_mul(y).and_then(|n| n.checked_mul(z));
    if voxels != Some(mask_length) || mask_length > MAX_VOXELS
        || x < 2 || y < 2 || z < 2 || mask.is_null() || output.is_null()
        || output_floats > MAX_TRIANGLES * 9
    {
        return -1;
    }
    let volume = std::slice::from_raw_parts(mask, mask_length);
    if volume.iter().any(|&v| v != 0 && v != 255) {
        return -1;
    }
    let triangles = std::slice::from_raw_parts_mut(output, output_floats);
    let mut written = 0;
    let mut vals = [0.0; 8];
    let mut vert = [0.0; 3];
    for k in 0..z - 1 {
        for j in 0..y - 1 {
            for i in 0..x - 1 {
                for (n, v) in INDEX_TO_VERTEX.iter().enumerate() {
                    let voxel = ((k + v[2] as usize) * y + j + v[1] as usize) * x + i + v[0] as usize;
                    vals[n] = volume[voxel] as f32 / 255.0;
                }
                let mut index = 0;
                for v in 0..8 {
                    if vals[v] <= 0.5 {
                        index |= 1 << v;
                    }
                }
                for t in TRI_TABLE[index].iter().take_while(|t| **t >= 0) {
                    if written + 3 > output_floats {
                        return -2;
                    }
                    let edge = EDGE_VERTICES[*t as usize];
                    lerp_verts(&INDEX_TO_VERTEX[edge[0]], &INDEX_TO_VERTEX[edge[1]],
                        vals[edge[0]], vals[edge[1]], 0.5, &mut vert);
                    triangles[written] = vert[0] + i as f32 + 0.5;
                    triangles[written + 1] = vert[1] + j as f32 + 0.5;
                    triangles[written + 2] = vert[2] + k as f32 + 0.5;
                    written += 3;
                }
            }
        }
    }
    written as i32
}
