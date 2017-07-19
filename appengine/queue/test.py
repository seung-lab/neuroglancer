import unittest
import webapp2
import json
# from the app main.py
import taskqueue
import time

class TestHandlers(unittest.TestCase):

    def tearDown(self):
        taskqueue.restart_module()

    def test_insert(self):
        request = webapp2.Request.blank('/myproject/taskqueue/myqueue/tasks')
        request.method = 'POST'
        body = {
            "payloadBase64": 'somepayload',
            "tag": 'task_a'
        }
        request.body = json.dumps(body)
        response = request.get_response(taskqueue.app)
        self.assertEqual(response.status_int, 200)

        response_body = json.loads(response.body)
        self.assertEqual(response_body["payloadBase64"], body["payloadBase64"])
        self.assertEqual(response_body["tag"], body["tag"])

        # try to insert the same id
        body['id'] = response_body['id']
        request = webapp2.Request.blank('/myproject/taskqueue/myqueue/tasks')
        request.method = 'POST'
        request.body = json.dumps(body)
        response = request.get_response(taskqueue.app)
        self.assertEqual(response.status_int, 400)

        #get task
        request = webapp2.Request.blank('/myproject/taskqueue/myqueue/tasks/'+response_body['id'])
        response = request.get_response(taskqueue.app)
        self.assertEqual(response.status_int, 200)

        # list all tasks
        request = webapp2.Request.blank('/myproject/taskqueue/myqueue/tasks')
        response = request.get_response(taskqueue.app)
        self.assertEqual(response.status_int, 200)
        self.assertEqual(len(json.loads(response.body)),1)

        #try to delete task
        request = webapp2.Request.blank('/myproject/taskqueue/myqueue/tasks/'+response_body['id'])
        request.method = "DELETE"
        response = request.get_response(taskqueue.app)
        self.assertEqual(response.status_int, 200)

    def test_lease(self):
        request = webapp2.Request.blank('/myproject/taskqueue/myqueue/tasks')
        request.method = 'POST'
        body = {
            "payloadBase64": 'somepayload',
            "tag": 'task_a'
        }
        request.body = json.dumps(body)
        response = request.get_response(taskqueue.app)

        # Lease the only available task
        request = webapp2.Request.blank('/myproject/taskqueue/myqueue/tasks/lease')
        request.method = 'POST'
        response = request.get_response(taskqueue.app)
        self.assertEqual(response.status_int, 200)
        self.assertEqual(len(json.loads(response.body)), 1)
        self.assertEqual(len(taskqueue.queues['myqueue'].pq._pq), 0)

        # no task should be available now
        request = webapp2.Request.blank('/myproject/taskqueue/myqueue/tasks/lease')
        request.method = 'POST'
        response = request.get_response(taskqueue.app)
        self.assertEqual(response.status_int, 200)
        self.assertEqual(len(json.loads(response.body)), 0)
        self.assertEqual(len(taskqueue.queues['myqueue'].pq._pq), 0)

        # task should be ready to be leased once again
        time.sleep(2)
        self.assertEqual(len(taskqueue.queues['myqueue'].pq._pq), 1)
        request = webapp2.Request.blank('/myproject/taskqueue/myqueue/tasks/lease')
        request.method = 'POST'
        response = request.get_response(taskqueue.app)
        self.assertEqual(response.status_int, 200)
        self.assertEqual(len(json.loads(response.body)), 1)

    def test_invalid_post(self):
        request = webapp2.Request.blank('/myproject/taskqueue/myqueue/tasks/oops')
        request.method = 'POST'
        request.body = 'hi'
        response = request.get_response(taskqueue.app)
        self.assertEqual(response.status_int, 400)

    def test_dependencies(self):
        #insert first task
        request = webapp2.Request.blank('/myproject/taskqueue/myqueue/tasks')
        request.method = 'POST'
        body = {
            "payloadBase64": 'somepayload',
            "tag": 'task_a'
        }
        request.body = json.dumps(body)
        response = request.get_response(taskqueue.app)
        first_id = json.loads(response.body)['id']

        # insert second task setting the first one as a depedency
        request = webapp2.Request.blank('/myproject/taskqueue/myqueue/tasks')
        request.method = 'POST'
        body['dependencies'] = [first_id]
        request.body = json.dumps(body)
        response = request.get_response(taskqueue.app)
        self.assertEqual(response.status_int, 200)
        snd_id = json.loads(response.body)['id']

        #try to delete the second task 
        #(this should fail because the first one has to be deleted first)
        request = webapp2.Request.blank('/myproject/taskqueue/myqueue/tasks/'+snd_id)
        request.method = "DELETE"
        response = request.get_response(taskqueue.app)
        self.assertEqual(response.status_int, 400)

        #we should be able to delete the first task
        request = webapp2.Request.blank('/myproject/taskqueue/myqueue/tasks/'+first_id)
        request.method = "DELETE"
        response = request.get_response(taskqueue.app)
        self.assertEqual(response.status_int, 200)

        #now that we deleted the first task, we should be able to delete the second one
        request = webapp2.Request.blank('/myproject/taskqueue/myqueue/tasks/'+snd_id)
        request.method = "DELETE"
        response = request.get_response(taskqueue.app)
        self.assertEqual(response.status_int, 200)