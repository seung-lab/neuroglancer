import boto3

client = boto3.client('batch')

resp = client.submit_job(
    jobName         = 'test',
    jobQueue        = 'inference',
    jobDefinition   = 'inference:2',
    containerProperties = {
        'image'     : '098703261575.dkr.ecr.us-east-1.amazonaws.com/chunkflow:v1.5.4',
        'command'   : [
            "julia",
            "/root/.julia/v0.5/ChunkFlow/scripts/main.jl"
        ],
        'vcpus'     : 4,
        'memory'    : 30500
    },
    retryStrategy   = {'attempts' : 3})
resp

resp = client.describe_compute_environments()
resp
