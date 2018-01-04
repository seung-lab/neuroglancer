from __future__ import print_function
from __future__ import division
from __future__ import absolute_import

import six  
from jinja2 import Template

from collections import defaultdict, deque
import logging
import webapp2
import os
import binascii
import json
import time
import threading
import sys

from priority_queue import PriorityQueue

with open('status.html') as htmlf:
    STATUS_PAGE_HTML = htmlf.read()

logging.getLogger().setLevel(logging.INFO)
"""
We are currently ignoring the project name in all our queries
"""

def now():
    """
    microseconds since 00:00:00 (UTC), Thursday, 1 January 1970
    minus the number of leap seconds that have taken place since then.
    """
    return int(time.time() * 10**6)

class Queue(object):
    def __init__(self):
        self.tasks = {}
        self._queue = deque()
        self._leased_timestamps = []
        self._next_id = 0
        self._next_id_lock = threading.Lock()

    def next_id(self):
        with self._next_id_lock:
            current = self._next_id
            self._next_id = (self._next_id + 1) % sys.maxint
        return current

    def _mark_leased_timestamp(self):
        last_hr = int(time.time()) - 3600
        self._leased_timestamps = list(filter(lambda x: x >= last_hr, self._leased_timestamps))
        self._leased_timestamps.append(int(time.time()))

    def leased_in_last(self, sec):
        the_past = int(time.time()) - sec
        return len(list(filter(lambda x: x >= the_past, self._leased_timestamps)))

    def purge(self):
        self.tasks = {}
        self._queue.clear()

    def enqueue(self, task):
        if task.id in self.tasks:
            raise ValueError("Already enqueued " + str(task.id) + task.to_json() + self.tasks[task.id].to_json())

        self._queue.append(task)
        self.tasks[task.id] = task

        for parent_id in task.parents:
            self.tasks[parent_id].children.update(task.id)
        for child_id in task.children:
            self.tasks[child_id].children.update(task.id)

        task.enqueueTimestamp = now()
            
    def lease(self, seconds, tag=None):
        moment = now()
        while len(self._queue):
            task = self._queue.popleft()
            self._queue.append(task)

            if moment < task.leaseTimestamp:
                continue
            elif tag and task.tag != tag:       
                continue
            else:
                task.lease(seconds)
                self._mark_leased_timestamp()
                return task
        return None

    def leases_outstanding(self):
        moment = now()
        count = 0

        for task in list(self._queue):
            if moment <= task.leaseTimestamp:
                count += 1
        return count

    def complete(self, task):
        self._queue.remove(task) # potentially slow
        del self.tasks[task.id]

        for parent_id in task.parents:
            self.tasks[parent_id].children.discard(task.id)

        for child_id in task.children:
            child = self.tasks[child_id]
            child.parents.discard(task.id)
            if len(child.parents) == 0:
                self.complete(child)

    def __len__(self):
        return len(self._queue)

queues = defaultdict(Queue)
def restart_module():
    global queues
    queues = defaultdict(Queue)

class Task(object):
    def __init__(self, id, payloadBase64, tag='',
        parents=[], children=[]):

        # dependencies are specified with their integer taskids, 
                
        self._id = id
        self._payloadBase64 = payloadBase64
        self.retry_count = 0
        self._tag = tag

        self.parents = set(parents)
        self.children = set(children)
        self.enqueueTimestamp = None
        self._leaseTimeStamp = 0

    @property
    def id(self):
        """  
        string  Unique name of the task. You may override the default generated name by specifying your own name when inserting the task.
        We strongly recommend against specifying a task name yourself.
        """
        return self._id
    
    @property
    def kind(self):
        """
        string  [Not mutable.] The kind of object returned, in this case set to task.
        """
        return "taskqueue#task"

    @property
    def leaseTimestamp(self):
        """  
        The time at which the task lease will expire, in microseconds since the epoch. 
        If this task has never been leased, it will be zero. 
        If this this task has been previously leased and the lease has expired, this value will be < Now().
        
        On task.insert, this must be set to the time at which the task will first be available for lease. 
        On task.lease, this property is not mutable and reflects the time at which the task lease will expire.  
        """
        return self._leaseTimeStamp

    @property
    def payloadBase64(self):
        """
        string  [Not mutable.] The bytes describing the task to perform. 
        This is a base64-encoded string.
        The client is expected to understand the payload format. 
        The maximum size is 1MB. This value will be empty in calls to tasks.list.
        Required for calls to tasks.insert. 
        """
        return self._payloadBase64
    
    @property
    def tag(self):
        """
        string  The tag for this task. 
        Tagging tasks allows you to group them for processing using lease.group_by_tag.
        """
        return self._tag

    def dependencies_met(self):
        return not self.children

    def to_json(self):
        return json.dumps(self.to_dict())

    def to_dict(self):
        return {
          "kind": self.kind,
          "id": self.id,
          "payloadBase64": self.payloadBase64,
          "enqueueTimestamp": self.enqueueTimestamp,
          "leaseTimestamp": self.leaseTimestamp,
          "retry_count": self.retry_count,
          "tag": self.tag,
          "children": list(self.children),
          "parents": list(self.parents),
        }

    def lease(self, lease_for):
        """
        time to lease for in seconds
        """
        assert self._leaseTimeStamp <= now()
        self._leaseTimeStamp = now() + lease_for * 10**6
        self.retry_count += 1

    def __hash__(self):
        return hash(self.id)


class TaskHandler(webapp2.RequestHandler):
    def get(self, project_name, taskqueue_name, maybe_task_name):
        self.response.headers.add_header('Access-Control-Allow-Origin', '*')

        queue =  queues[taskqueue_name]
        if not maybe_task_name:
            numTasks = int(self.request.get('N', default_value='100'))
            self._list_tasks(queue, numTasks)
        else:
            self._get_task(queue, maybe_task_name)


    def post(self, project_name, taskqueue_name, maybe_lease_or_task_name):
        self.response.headers.add_header('Access-Control-Allow-Origin', '*')
        
        args = maybe_lease_or_task_name.split('/')

        queue =  queues[taskqueue_name]
        if args[0] == 'lease':
            numTasks = int(self.request.get('numTasks', default_value='1'))
            assert numTasks >= 1
            leaseSecs = int(self.request.get('leaseSecs', default_value='1'))
            assert leaseSecs >= 1
            tag = self.request.get('tag', default_value='')

            self._lease_task(queue, numTasks, leaseSecs, tag)
        elif args[0] == '':
            self._insert_task(queue, taskqueue_name)
        elif args[0] == 'id':
            newLeaseSeconds = int(self.request.get('newLeaseSeconds', default_value='1'))
            assert newLeaseSeconds >= 1
            self._update_task(queue, args[1], newLeaseSeconds)

    def patch(self, project_name, taskqueue_name, task_name):
        self.response.headers.add_header('Access-Control-Allow-Origin', '*')

        queue =  queues[taskqueue_name]
        newLeaseSeconds = int(self.request.get('newLeaseSeconds', default_value='1'))
        assert newLeaseSeconds >= 1
        self._patch_task(queue, task_name, newLeaseSeconds)

    def delete(self, project_name, taskqueue_name, task_name):
        self.response.headers.add_header('Access-Control-Allow-Origin', '*')
        queue =  queues[taskqueue_name]
        self._delete_task(queue, task_name)

    def _delete_task(self, queue, task_name):
        """
        DELETE  /${projectname}/taskqueue/$(queuename)/tasks/$(taskname)
        Deletes a task from a TaskQueue.
        """
        tid = int(task_name)
        if (tid not in queue.tasks 
            or not queue.tasks[tid].dependencies_met()):

            self.response.write(
                task_name
                + " task name is invalid or has unmet dependencies")
            self.response.status = 400
            return
        
        task = queue.tasks[tid]
        queue.complete(task)
        logging.debug('deleted task '+ str(tid))

    def _get_task(self, queue, task_name):
        """
        GET  /$(projectname)/taskqueue/$(queuename)/tasks/$(taskname)
        Gets the named task in a TaskQueue.
        """
        if task_name not in queue.tasks:
            self.response.write(task_name + " task name is invalid")
            self.response.status = 400
            return
        self.response.write(queue.tasks[task_name].to_json())

    def _insert_task(self, queue, taskqueue_name):
        """
        POST  /$(projectname)/taskqueue/$(queuename)/tasks
        Insert a task into an existing queue.    
        """
        body_object = json.loads(self.request.body)
        
        try:
            task = Task(queue.next_id(), **body_object)
        except Exception as e:
            self.response.write(e)
            self.response.status = 400
            return
        queue.enqueue(task)
        self.response.write(task.to_json())

    def _lease_task(self, queue, numTasks, leaseSecs,  tag):
        """
        POST  /$(projectname)/taskqueue/$(queuename)/tasks/lease
        Acquires a lease on the topmost numTasks unowned tasks in the specified queue.
        Required query parameters: leaseSecs, numTasks, tag

        If it cannot lease numTasks tasks it will return as many as it can lease
        which might be an empty list if no tasks are leasable
        """
        tasks = []
        for _ in range(numTasks):
            task = queue.lease(leaseSecs, tag=tag)
            if task is not None:
                tasks.append(task)

        resp = json.dumps([ t.to_dict() for t in tasks ])
        self.response.write(resp)

    def _list_tasks(self, queue, numTasks):
        """
        GET  /$(projectname)/taskqueue/$(queuename)/tasks
        Lists all non-deleted Tasks in a TaskQueue,
        whether or not they are currently leased, up to a maximum of 100.
        """
        tasks_returned = []
        for _, task in list(queue.tasks.items()):
            if len(tasks_returned) >= numTasks:
                break
            d = task.to_dict()
            del d['payloadBase64']
            tasks_returned.append(d)
        self.response.write(json.dumps(tasks_returned))

    def _patch_task(self, queue, task_name, newLeaseSeconds):
        """
        PATCH  /$(projectname)/taskqueue/$(queuename)/tasks/$(taskname)
        Update tasks that are leased out of a TaskQueue.
        Required query parameters: newLeaseSeconds
        """
        if task_name not in queue.tasks:
            self.response.write(
                task_name+ " task name is invalid")
            self.response.status = 400
            return

        raise NotImplementedError()

    def _update_task(self, queue, task_name, newLeaseSeconds):
        """
        POST  /$(projectname)/taskqueue/$(queuename)/tasks/$(taskname)
        Update the duration of a task lease.
        Required query parameters: newLeaseSeconds
        """
        if task_name not in queue.tasks:
            self.response.write(
                task_name+ " task name is invalid")
            self.response.status = 400

            return

        # we need to check the task is not leased out
        raise NotImplementedError()

class TaskQueueHandler(webapp2.RequestHandler):
    """
    TODO we don't offer functionanility to create/delete
    taskqueue

    If inserting a task to a taskqueue that doesn't 
    exist will create a new queue
    We also don't offer functionality to list all the
    taskqueue names
    """
    def post(self, project_name, taskqueue_name):
        self.response.headers.add_header('Access-Control-Allow-Origin', '*')

        args = taskqueue_name.split('/')
        taskqueue_name = args[0]

        if taskqueue_name not in queues:
            msg = r"""{ "error": "Task queue %s does not exist." }""" % taskqueue_name
            self.response.write(msg)
            self.response.status = 404
            return
        
        queue = queues[taskqueue_name]

        if len(args) > 1:
            args[1] = args[1].replace('/', '')
            if args[1] == 'purge':
                queue.purge()
                self.response.write(r"""{ "msg": "purged" }""")
                return

    def get(self, project_name, taskqueue_name):
        """
        GET  /$(projectname)/taskqueue/$(queuename)
        Gets taskqueue information
        We should look like this:

            {
              "kind": "taskqueues#taskqueue",
              "id": string,
              "maxLeases": integer,
              "stats": {
                "totalTasks": integer,
                "oldestTask": long,
                "leasedLastMinute": long,
                "leasedLastHour": long
              },
              "acl": {
                "consumerEmails": [
                  string
                ],
                "producerEmails": [
                  string
                ],
                "adminEmails": [
                  string
                ]
              }
            }

        TODO(tartavull): currently returning a subset
        of this information
        """
        self.response.headers.add_header('Access-Control-Allow-Origin', '*')

        args = taskqueue_name.split('/')
        taskqueue_name = args[0]

        if taskqueue_name not in queues:
            msg = r"""{ "error": "Task queue %s does not exist." }""" % taskqueue_name
            self.response.write(msg)
            self.response.status = 404
            return

        queue = queues[taskqueue_name]

        if len(args) > 1:
            args[1] = args[1].replace('/', '')
            if args[1] == 'status':
                self.render_status_page(taskqueue_name, queue)
                return

        self.response.write(json.dumps(
            {
                "kind": "taskqueues#taskqueue",
                "stats": {
                    "totalTasks": len(queue),
                    "leasesOutstanding": queue.leases_outstanding(),
                    "leasedInLast": {
                        60: queue.leased_in_last(60),
                        600: queue.leased_in_last(600),
                        3600: queue.leased_in_last(3600),
                    },
                },
            }))

    def render_status_page(self, taskqueue_name, queue):
        global STATUS_PAGE_HTML

        template = Template(STATUS_PAGE_HTML)
        page = template.render(
            tqname=taskqueue_name,
            enqueued=len(queue),
            leases_outstanding=queue.leases_outstanding(),
            one_min=queue.leased_in_last(60),
            ten_min=queue.leased_in_last(600),
            one_hr=queue.leased_in_last(3600),
        )
        self.response.write(page)

app = webapp2.WSGIApplication([
    (r'/(.*)/taskqueue/(.*)/tasks/id/(.*)', TaskHandler),
    (r'/(.*)/taskqueue/(.*)/tasks/?(.*)', TaskHandler),
    (r'/(.*)/taskqueue/(.*)/?', TaskQueueHandler),
], debug=True)


            