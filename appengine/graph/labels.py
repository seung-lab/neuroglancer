import numpy as np

MAX_HEIGHT_BITS = 8
MAX_X_BITS = 8
MAX_Y_BITS = 8
MAX_Z_BITS = 8
MAX_INTRA_ID_BITS = 64 - MAX_HEIGHT_BITS - MAX_X_BITS - MAX_Y_BITS - MAX_Z_BITS

def to_label(chunk_height, chunk_x, chunk_y, chunk_z, intra_chunk_id):
    """
    Produces a 64bit unsinged integer from the inputs
    MAX_HEIGHT_BITS bits to represent the chunk_height
    MAX_X_BITS bits to represent the chunk_x
    MAX_Y_BITS bits to represent the chunk_y
    MAX_Z_BITS bits to represent the chunk_z
    MAX_INTRA_ID_BITS bits to represent the intra_chunk_id
    """
    if not (0 <= chunk_height < 2**MAX_HEIGHT_BITS and
            0 <= chunk_x < 2**MAX_X_BITS and 
            0 <= chunk_y < 2**MAX_Y_BITS and 
            0 <= chunk_z < 2**MAX_Z_BITS and
            0 <= intra_chunk_id < 2**MAX_INTRA_ID_BITS):
        raise ValueError("Arguments are not"\
                         " between allowable ranges")

    return np.uint64(chunk_height << MAX_X_BITS + MAX_Y_BITS + MAX_Z_BITS + MAX_INTRA_ID_BITS |
            chunk_x << MAX_Y_BITS + MAX_Z_BITS + MAX_INTRA_ID_BITS |
            chunk_y << MAX_Z_BITS + MAX_INTRA_ID_BITS |
            chunk_z << MAX_INTRA_ID_BITS |
            intra_chunk_id)

def from_label(label):
    label = int(label) #np.uint64 doesn't accept shifts
    mask = lambda s, k: 2**k - 1 & label >> s
    return (mask(MAX_X_BITS + MAX_Y_BITS + MAX_Z_BITS + MAX_INTRA_ID_BITS, MAX_HEIGHT_BITS), # chunk_height
            mask(MAX_Y_BITS + MAX_Z_BITS + MAX_INTRA_ID_BITS, MAX_X_BITS), #chunk_x
            mask(MAX_Z_BITS + MAX_INTRA_ID_BITS, MAX_Y_BITS), #chunk_y
            mask(MAX_INTRA_ID_BITS, MAX_Z_BITS), #chunk_z
            mask(0, MAX_INTRA_ID_BITS)) #intra_chunk_id

def from_chunk_key_and_intra(chunk_key, intra):
    args = from_chunk_key(chunk_key) + (intra,)
    return to_label(*args)

def to_chunk_key(chunk_height, chunk_x, chunk_y, chunk_z):
    return to_label(chunk_height, chunk_x, chunk_y, chunk_z, 0)

def from_chunk_key(chunk_key):
    return from_label(chunk_key)[:-1]

def intra_hash_from_children(children, k=MAX_INTRA_ID_BITS):
    return hash(tuple(children)) & 2**k - 1
