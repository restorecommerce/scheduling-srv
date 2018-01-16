'use strict';

import * as chassis from '@restorecommerce/chassis-srv';
import * as  Cluster from '@restorecommerce/cluster-service';
import * as co from 'co';

co(async function startCluster(): Promise<any> {
  const cfg: any = await co(chassis.config.get());
  const server: any = new Cluster(cfg);
  server.run('./worker.js');
}).catch((err) => {
  console.error(err);
});
