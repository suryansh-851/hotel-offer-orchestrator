import { once } from 'node:events';
import { Client, Connection, type WorkflowHandle } from '@temporalio/client';
import { createApp } from './app';
import { config } from './config';
import { inventory } from './fixtures';
import { runSearch, workflowExecutionTimeoutMs, type SearchPorts } from './search';
import { errorMessage, probeSupplier } from './suppliers';
import type { compareHotelOffers } from './workflows';

// Process bootstrap only. Routes and error handling live in app.ts.
async function run() {
  // Supplier inventory and health can be served while Temporal is starting.
  const connection = Connection.lazy({ address: config.temporalAddress });
  const client = new Client({ connection, namespace: config.namespace });
  const ports: SearchPorts<WorkflowHandle<typeof compareHotelOffers>> = {
    start: (search, workflowId, deadline) => connection.withDeadline(deadline, () =>
      client.workflow.start<typeof compareHotelOffers>('compareHotelOffers', {
        taskQueue: config.taskQueue, workflowId, args: [search], workflowExecutionTimeout: workflowExecutionTimeoutMs
      })
    ),
    result: (handle, deadline) => connection.withDeadline(deadline, () => handle.result())
  };
  const app = createApp({
    enableMockFaults: config.enableMockFaults,
    inventory,
    probeSupplier,
    search: (search, workflowId) => runSearch(ports, search, workflowId)
  });

  const server = app.listen(config.port);
  await once(server, 'listening');
  console.info(JSON.stringify({ event: 'api.listening', port: config.port }));
  const shutdown = () => server.close(() => { void connection.close(); });
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

run().catch(error => {
  console.error(JSON.stringify({ event: 'api.stopped', reason: errorMessage(error) }));
  process.exitCode = 1;
});
