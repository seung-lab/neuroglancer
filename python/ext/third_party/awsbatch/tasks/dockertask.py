import os
import json
import luigi
import string

class DockerTask(luigi.Task):

    environment = {
        'AWS_ACCESS_KEY_ID': os.environ.get('AWS_ACCESS_KEY_ID'),
        'AWS_SECRET_ACCESS_KEY': os.environ.get('AWS_SECRET_ACCESS_KEY')
    }
    volumes = {'/mnt': '/mnt'}
    image = ''
    command = []

    @property
    def parameters(self):
        """
        Parameters to pass to the command template

        Override to return a dict of key-value pairs to fill in command arguments
        """
        return {}

    def from_job_definition(self):
        pass

    def build_batch_job_definition(self):
        pass

    def _build_command(self):
        def get_param(arg):
            return self.parameters[arg.split('::')[1]]
        return [get_param(arg) if arg.startswith('Ref::') else arg
                for arg in self.command]

    def build_docker_run(self):
        cmd = ['docker', 'run', '--net=host', '-i']
        for name, value in self.environment.items():
            cmd += ['-e', '{}={}'.format(name, value)]
        for host, target in self.volumes.items():
            cmd += ['-v', '{}:{}'.format(host, target)]

        cmd.append(self.image)

        command = self._build_command()
        cmd += command

        return cmd
