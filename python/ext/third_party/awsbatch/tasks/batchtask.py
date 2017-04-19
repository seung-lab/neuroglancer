class BatchTask(DockerTask):

    """
    Base class for an Amazon Batch job

    Amazon Batch requires you to register "jobs", which are JSON descriptions
    for how to issue the ``docker run`` command. This Luigi Task can either
    run a pre-registered Batch jobDefinition, OR you can register the job on
    the fly from a Python dict.

    :param job_definition: pre-registered job definition ARN (Amazon Resource
        Name), of the form::

            arn:aws:batch:<region>:<user_id>:job-definition/<job-name>:<version>

    """

    job_definition = luigi.Parameter()
    job_name = luigi.Parameter(default='', significant=False)
    queue_name = luigi.Parameter(default='', significant=False)

    @property
    def batch_job_id(self):
        """Expose the Batch job ID"""
        if hasattr(self, '_job_id'):
            return self._job_id

    def run(self):
        if self.local:
            self.run_local()
            return

        # Use default queue if none specified
        queue_name = self.queue_name or DEFAULT_QUEUE_NAME

        # Get jobId if it already exists
        self._job_id = None
        if self.job_name:
            # Job name is unique. If the job exists, use its id
            jobs = client.list_jobs(jobQueue=queue_name, jobStatus='RUNNING')['jobSummaryList']
            matching_jobs = [job for job in jobs if job['jobName'] == self.job_name]
            if matching_jobs:
                self._job_id = matching_jobs[0]['jobId']


        # Submit the job to AWS Batch if it doesn't exist, get assigned job ID
        if not self._job_id:
            response = client.submit_job(
                jobName = self.job_name or random_id(),
                jobQueue = queue_name,
                jobDefinition = self.job_definition,
                parameters = self.parameters
            )
            self._job_id = response['jobId']

        # Wait on job completion
        status = _track_job(self._job_id)

        # Raise and notify if job failed
        if status == 'FAILED':
            data = client.describe_jobs(jobs=[self._job_id])['jobs']
            raise BatchJobException('Job {}: {}'.format(self._job_id, json.dumps(data, indent=4)))

    def run_local(self):
        cmd = self.build_docker_run()
        logger.info('Running local Docker command:\n{}'.format(' '.join(cmd)))
        out = check_output(cmd)
        logger.info(out.decode())
