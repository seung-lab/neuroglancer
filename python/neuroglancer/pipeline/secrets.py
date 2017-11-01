import os
import json

from oauth2client import service_account
from cloudvolume.lib import mkdir, colorize

QUEUE_NAME = 'pull-queue' if 'PIPELINE_USER_QUEUE' not in os.environ else os.environ['PIPELINE_USER_QUEUE']
TEST_QUEUE_NAME = 'test-pull-queue' if 'TEST_PIPELINE_USER_QUEUE' not in os.environ else os.environ['TEST_PIPELINE_USER_QUEUE']
QUEUE_TYPE = 'appengine' if 'QUEUE_TYPE' not in os.environ else os.environ['QUEUE_TYPE']
PROJECT_NAME = 'neuromancer-seung-import'
APPENGINE_QUEUE_URL = 'https://queue-dot-neuromancer-seung-import.appspot.com'

backwards_backwards_compatible_path = '/secrets'
backwards_compatible_path = os.path.join(os.environ['HOME'], '.neuroglancer/')
new_path = os.path.join(os.environ['HOME'], '.cloudvolume/')

if os.path.exists(new_path):
  CLOUD_VOLUME_DIR = new_path
elif os.path.exists(backwards_compatible_path):
  CLOUD_VOLUME_DIR = backwards_compatible_path
  print(colorize('yellow', 'Deprecation Warning: Directory ~/.cloudvolume is now preferred to ~/.neuroglancer.\nConsider running: mv ~/.neuroglancer ~/.cloudvolume'))
elif os.path.exists(backwards_backwards_compatible_path):
  print(colorize('yellow', 'Deprecation Warning: Directory ~/.cloudvolume is now preferred to /secrets.\nConsider running: mv /secrets/* ~/.cloudvolume/secrets/'))
else:
  CLOUD_VOLUME_DIR = mkdir(new_path)

secret_path = mkdir(os.path.join(CLOUD_VOLUME_DIR, 'secrets/'))

project_name_path = os.path.join(CLOUD_VOLUME_DIR, 'project_name')
if os.path.exists(project_name_path):
  with open(project_name_path, 'r') as f:
    PROJECT_NAME = f.read()

google_credentials_path = os.path.join(secret_path, 'google-secret.json')
if os.path.exists(google_credentials_path):
  service_account.ServiceAccountCredentials \
    .from_json_keyfile_name(google_credentials_path)
else:
  google_credentials = ''

aws_credentials_path = os.path.join(secret_path, 'aws-secret.json')
if os.path.exists(aws_credentials_path):
  with open(aws_credentials_path, 'r') as f:
    aws_credentials = json.loads(f.read())
else:
  aws_credentials = ''

boss_credentials_path = os.path.join(secret_path, 'boss-secret.json')
if os.path.exists(boss_credentials_path):
  with open(boss_credentials_path, 'r') as f:
    boss_credentials = json.loads(f.read())
else:
  boss_credentials = ''

