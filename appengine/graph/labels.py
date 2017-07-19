import numpy as np

def to_label(chunk_height, chunk_x, chunk_y, chunk_z, intra_chunk_id ):
    """
    Produces a 64bit unsinged integer from the inputs
    6 bits to represent the chunk_height -> 64
    12 bits to represent the chunk_x -> 4096
    12 bits to represent the chunk_y -> 4096
    10 bits to represent the chunk_z -> 1024
    24 bits to represent the intra_chunk_id -> 16777216
    """
    if not (0 <= chunk_height < 2**6 and
            0 <= chunk_x < 2**12 and 
            0 <= chunk_y < 2**12 and 
            0 <= chunk_z < 2**10 and
            0 <= intra_chunk_id < 2**24):
        raise ValueError("Arguments are not"\
                         " between allowable ranges")

    return np.uint64((chunk_height << 12 + 12 + 10 + 24) |
            (chunk_x << 12 + 10 + 24) |
            (chunk_y << 10 + 24) |
            (chunk_z << 24) |
            intra_chunk_id)

def from_label( label ):
    label = int(label) #np.uint64 doesn't accept shifts
    mask = lambda s , k: 2**(k) - 1 & label >> s
    return (mask(12 + 12 + 10 + 24, 6), # chunk_height
            mask(12+ 10 + 24, 12), #chunk_x
            mask(10+24, 12), #chunk_y
            mask(24, 10), #chunk_z
            mask(0, 24)) #intra_chunk_id

def from_chunk_key_and_intra( chunk_key, intra):
    args = from_chunk_key(chunk_key) + (intra,)
    return to_label(*args)

def to_chunk_key( chunk_height, chunk_x, chunk_y, chunk_z ):
    return to_label(chunk_height, chunk_x, chunk_y, chunk_z, 0)

def from_chunk_key( chunk_key ):
    return from_label( chunk_key )[:-1]

def intra_hash_from_children( children , k=24):
    return hash(tuple(children)) and 2**(k) - 1 