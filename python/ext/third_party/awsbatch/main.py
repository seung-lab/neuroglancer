"""
AWS Batch wrapper for Luigi

From the AWS website:

    AWS Batch enables you to run batch computing workloads on the AWS Cloud.

    Batch computing is a common way for developers, scientists, and engineers
    to access large amounts of compute resources, and AWS Batch removes the
    undifferentiated heavy lifting of configuring and managing the required
    infrastructure. AWS Batch is similar to traditional batch computing
    software. This service can efficiently provision resources in response to
    jobs submitted in order to eliminate capacity constraints, reduce compute
    costs, and deliver results quickly.

See `AWS Batch User Guide`_ for more details.

To use AWS Batch, you create a jobDefinition JSON that defines a `docker run`_
command, and then submit this JSON to the API to queue up the task. Behind the
scenes, AWS Batch auto-scales a fleet of EC2 Container Service instances,
monitors the load on these instances, and schedules the jobs.

This `boto3-powered`_ wrapper allows you to create Luigi Tasks to submit Batch
``jobDefinition`` s. You can either pass a dict (mapping directly to the
``jobDefinition`` JSON) OR an Amazon Resource Name (arn) for a previously
registered ``jobDefinition``.

Requires:

- boto3 package
- Amazon AWS credentials discoverable by boto3 (e.g., by using ``aws configure``
  from awscli_)
- An enabled AWS Batch job queue configured to run on a compute environment.

Written and maintained by Jake Feala (@jfeala) for Outlier Bio (@outlierbio)

.. _`docker run`: https://docs.docker.com/reference/commandline/run
.. _jobDefinition: http://http://docs.aws.amazon.com/batch/latest/userguide/job_definitions.html
.. _`boto3-powered`: https://boto3.readthedocs.io
.. _awscli: https://aws.amazon.com/cli
.. _`AWS Batch User Guide`: http://docs.aws.amazon.com/AmazonECS/latest/developerguide/ECS_GetStarted.html

"""

import json
import os
import logging
import random
import string
from subprocess import check_output
import time

import luigi

logger = logging.getLogger('luigi-interface')

try:
    import boto3
    client = boto3.client('batch')

    # Get dict of active queues keyed by name
    queues = {q['jobQueueName']:q for q in client.describe_job_queues()['jobQueues']
              if q['state'] == 'ENABLED' and q['status'] == 'VALID'}
    if not queues:
        logger.warning('No job queues with state=ENABLED and status=VALID')

    # Pick the first queue as default
    DEFAULT_QUEUE_NAME = list(queues.keys())[0]

except ImportError:
    logger.warning('boto3 is not installed. BatchTasks require boto3')


class BatchJobException(Exception):
    pass


POLL_TIME = 10


def random_id():
    return 'luigi-job-' + ''.join(random.sample(string.ascii_lowercase, 8))


def _get_job_status(job_id):
    """
    Retrieve task statuses from ECS API

    Returns list of {SUBMITTED|PENDING|RUNNABLE|STARTING|RUNNING|SUCCEEDED|FAILED} for each id in job_ids
    """
    response = client.describe_jobs(jobs=[job_id])

    # Error checking
    status_code = response['ResponseMetadata']['HTTPStatusCode']
    if status_code != 200:
        msg = 'Job status request received status code {0}:\n{1}'
        raise Exception(msg.format(status_code, response))

    return response['jobs'][0]['status']

def _track_job(job_id):
    """Poll task status until STOPPED"""

    while True:
        status = _get_job_status(job_id)
        if status in ['SUCCEEDED', 'FAILED']:
            logger.info('Batch job {0} finished'.format(job_id))
            return status

        time.sleep(POLL_TIME)
        logger.debug('Batch job status for job {0}: {1}'.format(
            job_id, status))


def register_job_definition(json_fpath):
    """Register a job definition with AWS Batch, using a JSON"""
    with open(json_fpath) as f:
        job_def = json.load(f)
    response = client.register_job_definition(**job_def)
    status_code = response['ResponseMetadata']['HTTPStatusCode']
    if status_code != 200:
        msg = 'Register job definition request received status code {0}:\n{1}'
        raise Exception(msg.format(status_code, response))
    return response
