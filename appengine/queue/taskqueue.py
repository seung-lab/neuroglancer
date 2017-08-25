from __future__ import print_function
from __future__ import division
from __future__ import absolute_import

import logging
import webapp2
import os
import binascii
import json
import time
from threading import Timer
from collections import defaultdict

from priority_queue import PriorityQueue

logging.getLogger().setLevel(logging.INFO)
"""
We are currently ignoring the project name in all our queries
"""

class Queue(object):
    """
    TODO: keep track of stats for
    https://cloud.google.com/appengine/docs/standard/python/taskqueue/rest/taskqueues#resource
    """
    def __init__(self):
        self._tasks = {}
        self._pq = PriorityQueue()

    @property
    def tasks(self):
        return self._tasks

    @property
    def pq(self):
        return self._pq

    def __len__(self):
        return len(self._tasks)

queues = defaultdict(Queue)
def restart_module():
    global queues
    queues = defaultdict(Queue)

def make_random_token():
    """Return a 20-byte (40 character) random hex string."""
    return binascii.hexlify(os.urandom(20))

def now():
    """
    microseconds since 00:00:00 (UTC), Thursday, 1 January 1970
    minus the number of leap seconds that have taken place since then.
    """
    return int(time.time() * 10**6)

class Task(object):

    def __init__(self, id=None, payloadBase64=None,
        queueName=None, retry_count=5, tag='',
        dependencies=[]):
        
        assert queueName
        self._queueName = queueName
        self._queue = queues[self._queueName]
        if id is None:
            while True:
                id =  make_random_token()
                if id not in self._queue.tasks:
                    break
        elif id in self._queue.tasks:
            raise ValueError(id + " already exists")
        elif id == 'lease':
            #we wouldn't know if you want to update a task
            #or lease some tasks
            raise ValueError(id + " is not a valid task name")

        self._id = id

        assert payloadBase64
        self._payloadBase64 = payloadBase64


        self._retry_count = retry_count

        self._tag = tag

        self._parents = set()
        self._children = set(dependencies)
        for child in dependencies:
            # we might have already deleted one of the dependencies
            # when this task is submitted
            # so we will ignore dependencies which doesn't exists
            if child in self._queue.tasks:
                self._queue.tasks[child]._parents.add(self.id)

        self._enqueueTimestamp = now()
        self._leaseTimeStamp = 0

        self._in_pq = False
        self.maybe_insert_into_pq()

    @property
    def enqueueTimestamp(self):
        """
        long[Not mutable.] Time (in microseconds since the epoch) at which the task was enqueued.
        """
        return self._enqueueTimestamp

    @property
    def id(self):
        """  
        string  Randomly generated name of the task. You may override the default generated name by specifying your own name when inserting the task.
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
    def queueName(self):
        """
        string  [Not mutable.] Name of the queue that the task is in.
        Required for calls to tasks.insert. 
        """
        return self._queueName
    
    @property
    def retry_count(self):
        """
        integer The number of leases applied to this task.  
        """
        return self._retry_count

    @property
    def tag(self):
        """
        string  The tag for this task. 
        Tagging tasks allows you to group them for processing using lease.group_by_tag.
        """
        return self._tag

    @property
    def children(self):
        """
        List of tasks' id which need to be fullfilled
        before this task can be leased
        """
        return list(self._children)

    def delete(self):
        for p in self._parents:
            # it cannot have been deleted
            # without deleting this task first
            assert p in self._queue.tasks
            self._queue.tasks[p]._children.remove(self.id)

    def dependencies_met(self):
        return not self._children

    def to_json(self):
        return json.dumps(self.to_dict())

    def to_dict(self):
        return {
          "kind": self.kind,
          "id": self.id,
          "queueName": self.queueName,
          "payloadBase64": self.payloadBase64,
          "enqueueTimestamp": self.enqueueTimestamp,
          "leaseTimestamp": self.leaseTimestamp,
          "retry_count": self.retry_count,
          "tag": self.tag,
          "children": self.children
        }


    def maybe_insert_into_pq(self):
        """
        We only want to have items in the priority queue
        which can be leased, so we check that dependencies
        are met before inserting.

        We use the time of insertion as the priority.
        Which will be similar to enqueueTimestamp when
        first inseting a task for first time. (with met dependencies)

        And similar to leaseTimeStamp when retrying a task.
        This means that when a task is retried it get pushed to the end
        of the queue. If we would insert with enqueueTimestamp after a 
        retry it would get executed inmediately.
        """
        if not self._children and not self._in_pq:
            self._in_pq = True
            self._queue.pq.add_item(now() , self.id)


    def _set_retry_timer(self, lease_for):
        """
        Re insert in pq after certain time

        It has to be a daemon so that the response is sent
        without waiting for this to be finished
        """
        t = Timer(lease_for, self.maybe_insert_into_pq, ())
        t.daemon = True
        t.start()
 
    def lease(self, lease_for):
        """
        time to lease for in seconds
        """
        assert self._leaseTimeStamp <= now()
        self._leaseTimeStamp = now() + lease_for * 10**6
        self._set_retry_timer(lease_for)

    def __hash__(self):
        return hash(self.id)


class TaskHandler(webapp2.RequestHandler):


    def get(self, project_name, taskqueue_name, maybe_task_name):
        queue =  queues[taskqueue_name]
        if not maybe_task_name:
            self._list_task(queue)
        else:
            self._get_task(queue, maybe_task_name)


    def post(self, project_name, taskqueue_name, maybe_lease_or_task_name):
        queue =  queues[taskqueue_name]
        if maybe_lease_or_task_name == 'lease':
            numTasks = int(self.request.get('numTasks', default_value='1'))
            assert numTasks >= 1
            leaseSecs = int(self.request.get('leaseSecs', default_value='1'))
            assert leaseSecs >= 1
            tag = self.request.get('tag', default_value='')

            self._lease_task(queue, numTasks, leaseSecs, tag)
        elif maybe_lease_or_task_name == '':
            self._insert_task(queue, taskqueue_name)
        else:
            newLeaseSeconds = int(self.request.get('newLeaseSeconds', default_value='1'))
            assert newLeaseSeconds >= 1
            self._update_task(queue, maybe_lease_or_task_name, newLeaseSeconds)

    def patch(self, project_name, taskqueue_name, task_name):
        queue =  queues[taskqueue_name]
        newLeaseSeconds = int(self.request.get('newLeaseSeconds', default_value='1'))
        assert newLeaseSeconds >= 1
        self._patch_task(queue, task_name, newLeaseSeconds)

    def delete(self, project_name, taskqueue_name, task_name):
        queue =  queues[taskqueue_name]
        self._delete_task(queue, task_name)

    def _delete_task(self, queue, task_name):
        """
        DELETE  /${projectname}/taskqueue/$(queuename)/tasks/$(taskname)
        Deletes a task from a TaskQueue.
        """
        if (task_name not in queue.tasks 
            or not queue.tasks[task_name].dependencies_met()):
            self.response.write(
                task_name
                + " task name is invalid or has unmet dependencies")
            self.response.status = 400
            return
        queue.tasks[task_name].delete()
        del queue.tasks[task_name]
        # we are not deleting it from the priority queue
        # so when we lease it, we might find that it doesn't exist
        logging.debug('deleted task '+ task_name)

    def _get_task(self, queue, task_name):
        """
        GET  /$(projectname)/taskqueue/$(queuename)/tasks/$(taskname)
        Gets the named task in a TaskQueue.
        """
        if task_name not in queue.tasks:
            self.response.write(
                task_name+ " task name is invalid")
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
            task = Task(queueName=taskqueue_name, **body_object)
        except Exception as e:
            self.response.write(e)
            self.response.status = 400
            return
        queue.tasks[task.id] = task
        self.response.write(task.to_json())

    def _lease_task(self, queue, numTasks, leaseSecs,  tag):
        """
        POST  /$(projectname)/taskqueue/$(queuename)/tasks/lease
        Acquires a lease on the topmost numTasks unowned tasks in the specified queue.
        Required query parameters: leaseSecs, numTasks, tag

        If it cannot lease numTasks tasks it will return as many as it can lease
        which might be an empty list if no tasks are leasable
        """
        task_to_lease = []
        for pq_idx , (_, task_name) in enumerate(queue.pq):
            if task_name not in queue.tasks:
                #we might have deleted this task
                #without ever leasing it
                queue.pq.delete_index(pq_idx)


            if tag and not queue.tasks[task_name] == tag:
                continue

            numTasks -= 1
            task_to_lease.append(task_name)
            queue.pq.delete_index(pq_idx)
            queue.tasks[task_name]._in_pq = False
            queue.tasks[task_name].lease(leaseSecs)

            if not numTasks:
                break
        self.response.write(json.dumps([queue.tasks[t].to_dict() for t in task_to_lease]))

    def _list_task(self, queue):
        """
        GET  /$(projectname)/taskqueue/$(queuename)/tasks
        Lists all non-deleted Tasks in a TaskQueue,
        whether or not they are currently leased, up to a maximum of 100.
        """
        tasks_returned = []
        for _, task in queue.tasks.iteritems():
            if len(tasks_returned) == 100:
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

        #we need to checked the task is out

        #we need to delete the old timer
        #and create a new one
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

class TaskQueuekHandler(webapp2.RequestHandler):
    """
    TODO we don't offer functionanility to create/delete
    taskqueue

    If inserting a task to a taskqueue that doesn't 
    exist will create a new queue
    We also don't offer functionality to list all the
    taskqueue names
    """

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
        if taskqueue_name not in queues:
            self.response.write("taskqueue does not exist")
            self.response.status = 404
            return

        queue =  queues[taskqueue_name]
        self.response.write(json.dumps(
            {
                "kind": "taskqueues#taskqueue",
                "stats": {
                    "totalTasks": len(queue)
                    }
            }))

app = webapp2.WSGIApplication([
    (r'/(.*)/taskqueue/(.*)/tasks/?(.*)', TaskHandler),
    (r'/(.*)/taskqueue/(.*)/?', TaskQueuekHandler)
], debug=True)


            