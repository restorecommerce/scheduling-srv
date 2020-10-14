import { createServiceConfig } from '@restorecommerce/service-config';
import * as Cluster from '@restorecommerce/cluster-service';

const cfg = createServiceConfig(process.cwd());
const server = new Cluster(cfg);
server.run('./lib/worker');
process.on('SIGINT', () => {
  server.stop();
});
