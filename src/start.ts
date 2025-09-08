import { Worker } from './worker.js';
import { createServiceConfig } from '@restorecommerce/service-config';
import { createLogger } from '@restorecommerce/logger';
import { decomposeError } from './utilts.js';

// cfg and logger
const cfg = createServiceConfig(process.cwd());
const loggerCfg = cfg?.get('logger') || {};
const logger = createLogger(loggerCfg);

const worker = new Worker();
worker.start(cfg).then().catch((err) => {
  logger.error('startup error', decomposeError(err));
  process.exit(1);
});

process.on('SIGINT', () => {
  worker.stop().then().catch((err) => {
    logger.error('shutdown error', decomposeError(err));
    process.exit(1);
  });
});
