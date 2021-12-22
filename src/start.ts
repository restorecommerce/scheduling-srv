import { createServiceConfig } from '@restorecommerce/service-config';
import Cluster from '@restorecommerce/cluster-service';

const cfg = createServiceConfig(process.cwd());
const server = new Cluster(cfg);
server.run('./lib/worker');
process.on('SIGINT', () => {
  server.stop();
});
