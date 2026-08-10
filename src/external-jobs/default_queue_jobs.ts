import {
  type DefaultExportFunc,
  register,
  execute,
} from '@restorecommerce/scs-jobs';

export const main: DefaultExportFunc = async (cfg, logger, events, runWorker) => {
  logger?.debug('Default Job Funktion found and loaded.');
  await runWorker('default-queue', 1, cfg, logger, events as any, async (job: any) => {
    // depending on job type add implementation here for Jobs to be run on default-queue
    logger?.debug('Default Job Funktion triggered and executed.');
  });
};

register(main);
export default execute;