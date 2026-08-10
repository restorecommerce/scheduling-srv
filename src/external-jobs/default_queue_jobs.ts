import {
  type DefaultExportFunc,
  register,
  execute,
} from '@restorecommerce/scs-jobs';

export const main: DefaultExportFunc = async (cfg, logger, events, runWorker) => {
  await runWorker('default-queue', 1, cfg, logger, events as any, async (job: any) => {
    // depending on job type add implementation here for Jobs to be run on default-queue
  });
};

register(main);
export default execute;