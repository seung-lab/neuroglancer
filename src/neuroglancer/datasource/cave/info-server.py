#!/usr/bin/env python3
from http.server import HTTPServer, SimpleHTTPRequestHandler, test
import sys

class CORSRequestHandler (SimpleHTTPRequestHandler):
    def end_headers (self):
        self.send_header('Access-Control-Allow-Origin', '*')
        SimpleHTTPRequestHandler.end_headers(self)

if __name__ == '__main__':
    test(CORSRequestHandler, HTTPServer, port=int(sys.argv[1]) if len(sys.argv) > 1 else 8000)



# /*
# {
#     "chunk_size" : [ 192768, 131328, 13056 ],
#     "grid_shape" : [ 1, 1, 1 ],
#     "key" : "spatial0",
#     "limit" : 10000
# }*/