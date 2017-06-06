#!/usr/bin/env python

import boto3
client = boto3.client('ecs')

def create_cluster( clusterName = 'chunkflow' ):
    resp = client.create_cluster( clusterName = clusterName )
    return resp 

def register_task_definition():
    resp = client.register_task_definition(
            family      = 'convnet-inference',
            taskRoleArn = 'arn:aws:iam::098703261575:role/ecsInstanceRole',
            networkMode = 'host',
            containerDefinitions = {
                'name'      : 'convnet-inference',
                'image'     : '098703261575.dkr.ecr.us-east-1.amazonaws.com/chunkflow:latest',
                'cpu'       : 2,
                'memory'    : 20000,
                'memoryReservation' : 20000,
                'essential' : True,
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
                'user'                      : 'root',
                'workingDirectory'          : '/root/.julia/v0.5/ChunkFlow/scripts/',
                'privileged'                : True,
                'logConfiguration'          : {
                    'logDriver'             : 'awslogs',
                    'options'               : {
                        'awslogs-region'    : 'us-east-1',
                        'awslogs-group'     : 'convnet-inference',
                        'awslogs-stream-prefix' : 'convnet-inference'
                    }
                },
        },
    )
    return resp 

def run_task( queueName = 'convnet-inference', count = 1 ):
    resp = client.run_task(
        cluster = 'chunkflow',
        taskDefinition = 'convnet-inference',
        overrides = {
            'containerOverrides'    : [
                {
                    'name'          : 'convnet-inference',
                    'command'       : [
                        'julia main.jl -q {}'.format(queueName)
                    ]
                }
            ]
        },
        count = count,
        group = 'convnet-inference',
        placementConstraints = [
            {
                'type'          : 'memberOf',
                'expression'    : 'attribute:ecs.instance-type == p2.xlarge'
            }
        ],
        placementStrategy   = [
            {
                'type'              : 'spread',
                'field'             : 'host'
            }
        ]
    )
    return resp 


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--queuename", "-q", 
                        default = 'convnet-inference', 
                        help    = "AWS SQS queue name")
    parser.add_argument("--number", "-n", 
                        default = 1, 
                        help    = "number of tasks")
    args = parser.parse_args()
    
    register_task_definition()
    run_task(   queueName   = args.queuename, 
                count       = args.number )
