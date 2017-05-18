#!/usr/bin/env python

import boto3
client = boto3.client('batch')

def create_compute_environment():
    resp = client.create_compute_environment(
        computeEnvironmentName  = 'convnet-inference',
        type                    = 'MANAGED',
        state                   = 'ENABLED',
        computeResources        = {
            'type'              : 'SPOT',
            'minvCpus'          : 0,
            'maxvCpus'          : 2048,
            'desiredvCpus'      : 0,
            'instanceTypes'     : [ 'p2.xlarge' ],
            'imageId'           : 'ami-76c0ab60',
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


def register_job_definition(queueName='s1-inference'):
    resp = client.register_job_definition(
        jobDefinitionName               = queueName,
        type                            = 'container',
        parameters                      = {
            'queuename'                 : queueName,
            'workernumber'              : '1',
            'processnumber'             : '1',
            'waittime'                  : '5'
        },
        containerProperties             = {
            'image'                     : '098703261575.dkr.ecr.us-east-1.amazonaws.com/chunkflow',
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
            'volumes'                   : [
                {
                    'host': {
                        'sourcePath'    : '/var/lib/nvidia-docker/volumes/nvidia_driver/latest'
                    },
                    'name'              : 'nvidia'
                }
            ],
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
            'mountPoints'               : [
                {
                    "containerPath": "/usr/local/nvidia",
                    "readOnly": False,
                    "sourceVolume": "nvidia"
            	}
            ],
            'privileged'                : False,
            'ulimits'                   : [],
            'user'                      : 'root'
        },
        retryStrategy                   = {
            'attempts'                  : 3
        })

def create_job_queue():
    resp = client.create_job_queue(
        jobQueueName                    = 'convnet-inference',
        state                           = 'ENABLED',
        priority                        = 50,
        computeEnvironmentOrder = [
            {
                'order'                 : 1,
                'computeEnvironment'    : 'convnet-inference'
            }
        ])

def submit_job( jobDefinition = 's1-inference' ):
    resp = client.submit_job(
        jobName         = 'convnet-inference',
        jobQueue        = 'convnet-inference',
        jobDefinition   = jobDefinition,
        parameters      = {
            'queuename'     : 's1-inference',
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

if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--queuename", "-q", help = "AWS SQS queue name")
    args = parser.parse_args()

    #create_compute_environment()
    #create_job_queue( )
    #register_job_definition( args.queuename )
    submit_job( args.queuename )
