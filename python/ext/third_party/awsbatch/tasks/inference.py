#!/usr/bin/env python

import boto3

client = boto3.client('batch')



resp = client.create_compute_environment(
    computeEnvironmentName  = 'convnet-inference-6',
    type                    = 'MANAGED',
    state                   = 'ENABLED',
    computeResources        = {
        'type'              : 'SPOT',
        'minvCpus'          : 0,
        'maxvCpus'          : 4000,
        'desiredvCpus'      : 2,
        'instanceTypes'     : [ 'p2.xlarge', ],
        # 'imageId'           : 'ami-06ae2e10',
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



resp = client.register_job_definition(
    jobDefinitionName               = 'convent-inference-6',
    type                            = 'container',
    parameters                      = {
        'queuename'                 : 'pinky40-inference',
        'workernumber'              : '1',
        'processnumber'             : '1',
        'waittime'                  : '5'
    },
    containerProperties             = {
        'image'                     : 'ami-06ae2e10',
        'vcpus'                     : 2,
        'memory'                    : 30500,
        'command'                   : [
            "julia",
            "-p", "Ref::processnumber",
            "/root/.julia/v0.5/ChunkFlow/scripts/main.jl",
            "-q", "Ref::queuename",
            "-n", "Ref::workernumber",
            "-w", "Ref::waittime"
        ],
        'jobRoleArn'                : 'arn:aws:iam::098703261575:role/chunkflow-worker',
        'volumes'                   : [],
        'environment'               : [
            {
                'name'              : 'PYTHONPATH',
                'value'             : '$PATHONPATH:/opt/caffe/python'
            },
            {
                'name'              : 'PYTHONPATH',
                'value'             : '$PATHONPATH:/opt/kaffe/layers',
            },
            {
                'name'              : 'PYTHONPATH',
                'value'             : '$PATHONPATH:/opt/kaffe'
            },
            {
                'name'              : 'LD_LIBRARY_PATH',
                'value'             : '${LD_LIBRARY_PATH}:/opt/caffe/build/lib'
            }
        ],
        'mountPoints'               : [],
        # 'readonlyRootFileSystem'    : False,
        'privileged'                : False,
        'user'                      : 'root'
    },
    retryStrategy                   = {
        'attempts'                  : 3
    })

resp = client.create_job_queue(
    jobQueueName                    = 'convnet-inference-6',
    state                           = 'ENABLED',
    priority                        = 50,
    computeEnvironmentOrder = [
        {
            'order'                 : 1,
            'computeEnvironment'    : 'convnet-inference-6'
        }
    ])

resp = client.submit_job(
    jobName         = 'pinky40-inference',
    jobQueue        = 'convnet-inference-6',
    jobDefinition   = 'inference:3',
    parameters      = {
        'queuename'     : 'pinky-inference',
        'processnumber' : '2',
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
