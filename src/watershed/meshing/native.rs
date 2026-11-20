// MIT: extraction adapted from Will Usher's pinned implementation; see README.md.
// The table, corner/edge numbering, and interpolation are included unchanged.
include!(env!("MC_CORE_RS"));

const MAX_VOXELS: usize = 1 << 26;
const MAX_TRIANGLES: usize = 1 << 20;
const INVALID_INPUT: i32 = -1;
const OVER_BUDGET: i32 = -2;

#[no_mangle]
pub extern "C" fn mc_alloc(bytes: usize) -> *mut u8 {
    if bytes == 0 || bytes > MAX_VOXELS.max(MAX_TRIANGLES * 9 * 4) {
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

// Caller owns valid, non-overlapping allocations for each ABI call. Both passes
// use the same corner bits, table prefix and traversal order; neither allocates.
unsafe fn visit_surface(
    mask: *const u8,
    mask_length: usize,
    x: usize,
    y: usize,
    z: usize,
    mut visit: impl FnMut(i32, i32, i32, [u8; 8], &[i32]) -> Result<(), i32>,
) -> Result<(), i32> {
    let voxels = x.checked_mul(y).and_then(|n| n.checked_mul(z));
    if voxels != Some(mask_length) || mask_length > MAX_VOXELS
        || x == 0 || y == 0 || z == 0 || mask.is_null()
    {
        return Err(INVALID_INPUT);
    }
    let volume = std::slice::from_raw_parts(mask, mask_length);
    if volume.iter().any(|&v| v != 0 && v != 255) {
        return Err(INVALID_INPUT);
    }
    let mut visit_cell = |i, j, k, vals: [u8; 8]| {
        if vals == [0; 8] || vals == [255; 8] {
            return Ok(());
        }
        let mut index = 0;
        for (v, &value) in vals.iter().enumerate() {
            index |= usize::from(value == 0) << v;
        }
        visit(i, j, k, vals, &TRI_TABLE[index][..CASE_EDGES[index] as usize])
    };

    let offsets = INDEX_TO_VERTEX.map(|[dx, dy, dz]| (dz as usize * y + dy as usize) * x + dx as usize);
    for k in 0..z - 1 {
        for j in 0..y - 1 {
            for i in 0..x - 1 {
                let base = (k * y + j) * x + i;
                visit_cell(i as i32, j as i32, k as i32, offsets.map(|offset| volume[base + offset]))?;
            }
        }
    }

    // Visit the one-cell shell without padding the mask or slowing interior
    // sampling. Assign shared shell edges/corners to Z faces, then Y, then X.
    let (x, y, z) = (x as i32, y as i32, z as i32);
    let mut visit_boundary = |i: i32, j: i32, k: i32| {
        let vals = INDEX_TO_VERTEX.map(|[dx, dy, dz]| {
            let (sx, sy, sz) = (i + dx as i32, j + dy as i32, k + dz as i32);
            if sx < 0 || sx >= x || sy < 0 || sy >= y || sz < 0 || sz >= z {
                0
            } else {
                volume[((sz * y + sy) * x + sx) as usize]
            }
        });
        visit_cell(i, j, k, vals)
    };
    for j in -1..y {
        for i in -1..x {
            visit_boundary(i, j, -1)?;
            visit_boundary(i, j, z - 1)?;
        }
    }
    for k in 0..z - 1 {
        for i in -1..x {
            visit_boundary(i, -1, k)?;
            visit_boundary(i, y - 1, k)?;
        }
        for j in 0..y - 1 {
            visit_boundary(-1, j, k)?;
            visit_boundary(x - 1, j, k)?;
        }
    }
    Ok(())
}

// Returns an exact triangle count, -1 for invalid input, or -2 once over budget.
#[no_mangle]
pub unsafe extern "C" fn mc_count(mask: *const u8, mask_length: usize, x: usize, y: usize, z: usize) -> i32 {
    let mut count = 0;
    let result = visit_surface(mask, mask_length, x, y, z, |_, _, _, _, edges| {
        count += edges.len() / 3;
        if count > MAX_TRIANGLES { Err(OVER_BUDGET) } else { Ok(()) }
    });
    result.map_or_else(|status| status, |_| count as i32)
}

// Returns the float count, -1 for invalid input, or -2 for insufficient capacity.
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
    if output.is_null() || output_floats > MAX_TRIANGLES * 9 {
        return INVALID_INPUT;
    }
    let triangles = std::slice::from_raw_parts_mut(output.cast::<std::mem::MaybeUninit<f32>>(), output_floats);
    let mut written = 0;
    let result = visit_surface(mask, mask_length, x, y, z, |i, j, k, vals, edges| {
        if written + edges.len() * 3 > output_floats {
            return Err(OVER_BUDGET);
        }
        let vals = vals.map(|v| v as f32 / 255.0);
        let mut vert = [0.0; 3];
        for &t in edges {
            let edge = EDGE_VERTICES[t as usize];
            lerp_verts(&INDEX_TO_VERTEX[edge[0]], &INDEX_TO_VERTEX[edge[1]],
                vals[edge[0]], vals[edge[1]], 0.5, &mut vert);
            triangles[written].write(vert[0] + i as f32 + 0.5);
            triangles[written + 1].write(vert[1] + j as f32 + 0.5);
            triangles[written + 2].write(vert[2] + k as f32 + 0.5);
            written += 3;
        }
        Ok(())
    });
    result.map_or_else(|status| status, |_| written as i32)
}
