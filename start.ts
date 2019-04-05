import * as sconfig from '@restorecommerce/service-config';
import * as Cluster from '@restorecommerce/cluster-service';

const cfg = sconfig(process.cwd());
const server = new Cluster(cfg);
server.run('./service');
process.on('SIGINT', () => {
  server.stop();
});
