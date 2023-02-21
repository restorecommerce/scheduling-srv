export default async (cfg, logger, events, runWorker) => {
  await runWorker('external-job', 1, cfg, logger, events, async (job) => ({
    result: job.id
  }));
};
