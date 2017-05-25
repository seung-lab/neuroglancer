from tqdm import tqdm
import os
import re
import json
from collections import defaultdict
from neuroglancer.pipeline import Storage
import sys

lsfilename = '{}.txt'.format(sys.argv[1])

with open(lsfilename) as f:
  files = f.readlines()

layer_path = os.path.dirname(files[0])
files = [ os.path.basename(fname)[:-1] for fname in files ]

segids = defaultdict(list)

for fname in files:
  segid, = re.match('(\d+):', fname).groups()
  segid = int(segid)
  segids[segid].append(fname)

print(layer_path)
with Storage(layer_path) as stor:
  for segid, frags in tqdm(segids.items()):
    stor.put_file(
      file_path='{}:0'.format(segid),
      content=json.dumps({ "fragments": frags }),
      content_type='application/json',
    )



  
