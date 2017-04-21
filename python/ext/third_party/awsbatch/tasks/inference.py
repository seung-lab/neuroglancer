#!/usr/bin/env python

import boto3

client = boto3.client('batch')

resp = client.submit_job(
    jobName         = 'pinky40-inference',
    jobQueue        = 'convnet-inference-4',
    jobDefinition   = 'inference:3',
    parameters      = {
        'queuename'     : 'pinky-inference',
        'processnumber' : '4',
        'workernumber'  : '1',
        'waittime'      : '5'
    },
    containerOverrides = {
        'command'   : [
            "julia",
            "-p", "Ref::processnumber",
            "/root/.julia/v0.5/ChunkFlow/scripts/main.jl",
            "-q", "Ref::queuename",
            "-n", "Ref::workernumber",
            "-w", "Ref::waittime"
        ],
        'vcpus'     : 2,
        'memory'    : 30500
    },
    retryStrategy   = {'attempts' : 3})


resp = client.create_compute_environment(
    computeEnvironmentName  = 'convnet-inference-4',
    type                    = 'MANAGED',
    state                   = 'ENABLED',
    computeResources        = {
        'type'              : 'SPOT',
        'minvCpus'          : 0,
        'maxvCpus'          : 4000,
        'desiredvCpus'      : 2,
        'instanceTypes'     : [ 'p2.xlarge', ],
        'imageId'           : 'ami-06ae2e10',
        'subnets'           : ['subnet-fb3626a0',],
        'securityGroupIds'  : ['sg-35753f4a',],
        'ec2KeyPair'        : 'jpwu_workstation',
        'instanceRole'      : 'arn:aws:iam::098703261575:role/chunkflow-worker',
        # spot compute environment do not support tagging!
        # 'tags'              : {
        #     'User'          : 'jingpeng',
        #     'Project'       : 'pinky40'
        # },
        'bidPercentage'     : 91,
        'spotIamFleetRole'  : 'arn:aws:iam::098703261575:role/aws-ec2-spot-fleet-role'
    },
    serviceRole             = 'arn:aws:iam::098703261575:role/service-role/AWSBatchServiceRole')
resp
resp = client.describe_compute_environments()

resp = client.create_job_queue(
    jobQueueName                    = 'convnet-inference-4',
    state                           = 'ENABLED',
    priority                        = 50,
    computeEnvironmentOrder = [
        {
            'order'                 : 1,
            'computeEnvironment'    : 'convnet-inference-4'
        }
    ])
