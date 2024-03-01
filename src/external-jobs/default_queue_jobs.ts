export default async (cfg, logger, events, runWorker) => {
  await runWorker('default-queue', 1, cfg, logger, events, async (job) => {
    // depending on job type add implementation here for Jobs to be run on default-queue
  });
};