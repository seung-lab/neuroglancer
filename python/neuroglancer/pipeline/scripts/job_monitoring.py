from __future__ import print_function

import time
import json
import sys

import requests

from neuroglancer.pipeline import TaskQueue

tq = TaskQueue(queue_name='wms-test-pull-queue', n_threads=0)

job_name = ' '.join(sys.argv[1:])

alerting = True

sleep_rate = 15.0

def alert(msg):
  print("Sent " + msg)

  data = { 'text': msg }

  r = requests.post(
    'https://hooks.slack.com/services/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', 
    data=json.dumps(data), 
    headers={'Content-Type': 'application/json'}
  )

last_enq = tq.enqueued 

stats = [ 10 for _ in xrange(20) ]
stats_i = 0

while True:
  try:
    enq = tq.enqueued
  except err:
    print(err)
    continue

  if enq is None:
    print("NONE")
    continue

  stats[stats_i] = last_enq - enq
  stats_i = (stats_i + 1) % len(stats)

  avg = float(sum(stats)) / float(len(stats))

  avg_completion_rate = avg / float(sleep_rate) * 60.0

  eta = float(enq) / (avg_completion_rate + 0.00001) / 60.0 

  sys.stdout.write("\r{} tasks remaining, completions/min: {}, eta: {} hrs".format(enq, avg_completion_rate, eta))
  sys.stdout.flush()

  if avg < 1 and alerting:
    alerting = False
    alert("WARNING: 0 tasks leased in past few minutes")
  elif avg > 0:
    alerting = True

  last_enq = enq
  time.sleep(sleep_rate)

alert("{} complete!".format(job_name))


