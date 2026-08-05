import {
  type DefaultExportFunc
} from '@restorecommerce/scs-jobs';

const main: DefaultExportFunc = async (cfg, logger, events, runWorker) => {
  const arangoDb = await create(cfg.get('arangoDb'), logger);
  logger?.info('ArangoDB found:', arangoDb.db);
  await runWorker('default-queue', 1, cfg, logger, events as any, async (job: any) => {
    // depending on job type add implementation here for Jobs to be run on default-queue
  });
};

export default main;

import {
  create
} from '@restorecommerce/chassis-srv/lib/database/provider/arango/index.js';