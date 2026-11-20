import { once } from 'node:events';
import { createServer } from 'node:http';
import { NativeConnection, Worker } from '@temporalio/worker';
import Redis from 'ioredis';
import { createActivities } from './activities';
import { config } from './config';
import { errorMessage } from './suppliers';

async function run() {
  const redis = new Redis(config.redisUrl, {
    lazyConnect: true, enableOfflineQueue: false, connectTimeout: 2000,
    commandTimeout: 2000, maxRetriesPerRequest: 1
  });
  redis.on('error', error => console.error(JSON.stringify({ event: 'redis.error', reason: error.message })));
  let connection: NativeConnection | undefined;
  let worker: Worker | undefined;
  const readiness = createServer(async (req, res) => {
    if (req.method !== 'GET' || req.url !== '/ready') {
      res.writeHead(404).end();
      return;
    }
    const temporal = connection;
    if (!temporal || worker?.getState() !== 'RUNNING' || redis.status !== 'ready') {
      res.writeHead(503).end();
      return;
    }
    try {
      await Promise.all([
        temporal.withDeadline(Date.now() + 1000, () => temporal.workflowService.getSystemInfo({})),
        redis.ping()
      ]);
      res.writeHead(200).end();
    } catch {
      res.writeHead(503).end();
    }
  });
  try {
    if (config.workerHealthPort !== undefined) {
      readiness.listen(config.workerHealthPort, '127.0.0.1');
      await once(readiness, 'listening');
    }
    await redis.connect();
    connection = await NativeConnection.connect({ address: config.temporalAddress });
    worker = await Worker.create({
      connection, namespace: config.namespace, taskQueue: config.taskQueue,
      workflowsPath: require.resolve('./workflows'), activities: createActivities(redis)
    });
    await worker.run();
  } finally {
    if (readiness.listening) readiness.close();
    redis.disconnect();
    await connection?.close();
  }
}

run().catch(error => {
  console.error(JSON.stringify({ event: 'worker.stopped', reason: errorMessage(error) }));
  process.exitCode = 1;
});
