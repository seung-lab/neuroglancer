import os
import json

from oauth2client import service_account

QUEUE_NAME = 'pull-queue' if 'PIPELINE_USER_QUEUE' not in os.environ else os.environ['PIPELINE_USER_QUEUE']
TEST_QUEUE_NAME = 'test-pull-queue' if 'TEST_PIPELINE_USER_QUEUE' not in os.environ else os.environ['TEST_PIPELINE_USER_QUEUE']
PROJECT_NAME = 'neuromancer-seung-import'
APPENGINE_QUEUE_URL = 'https://queue-dot-neuromancer-seung-import.appspot.com'

google_credentials_path = '/secrets/google-secret.json'
google_credentials = service_account.ServiceAccountCredentials \
  .from_json_keyfile_name(google_credentials_path)

aws_credentials_path =  '/secrets/aws-secret.json'
with open(aws_credentials_path, 'rb') as f:
  aws_credentials = json.loads(f.read())