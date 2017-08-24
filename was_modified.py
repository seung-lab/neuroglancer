#!/usr/bin/env python
from __future__ import print_function
import subprocess
import sys
import os.path
import urllib2
import json
# filepath starts from the root directory of the git project
# with not trailing slash at the begining
# the last -- it's no separte revisions from files

def get_modified_files():
    if os.environ['TRAVIS_PULL_REQUEST'] != 'false':
        url = "https://api.github.com/repos/{}/pulls/{}/files".format(
            os.environ['TRAVIS_REPO_SLUG'], os.environ['TRAVIS_PULL_REQUEST'])
        file_dict =  json.loads(urllib2.urlopen(url).read())

    else:
        url = "https://api.github.com/repos/{}/compare/{}".format(
            os.environ['TRAVIS_REPO_SLUG'], os.environ['TRAVIS_COMMIT_RANGE'])
        file_dict =  json.loads(urllib2.urlopen(url).read())['files']

    files = []
    for file_description in file_dict:
        files.append(file_description['filename'])
    return files
if os.environ['TRAVIS_EVENT_TYPE'] == 'cron':
    #In case of cron builds, we want to test and deploy everything
    print("true")
    sys.exit(0)

path = sys.argv[1]
for file in get_modified_files():
    if path in file:
        print("true")
        sys.exit(0)

print("false")
sys.exit(1)
