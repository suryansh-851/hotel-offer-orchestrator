import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import express, { type ErrorRequestHandler } from 'express';
import { Client, Connection, WorkflowFailedError, isGrpcDeadlineError } from '@temporalio/client';
import { ApplicationFailure, TimeoutFailure } from '@temporalio/common';
import { config } from './config';
import { normalize, suppliers } from './domain';
import { inventory } from './fixtures';
import { InputError, parseCity, parseOutage, parseSearch } from './query';
import { errorMessage, probeSupplier } from './suppliers';
import type { compareHotelOffers } from './workflows';

const workflowStartTimeoutMs = 5000;
const workflowExecutionTimeoutMs = 30000;

async function run() {
  // Supplier inventory and health can be served while Temporal is starting.
  const connection = Connection.lazy({ address: config.temporalAddress });
  const client = new Client({ connection, namespace: config.namespace });
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  app.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  for (const supplier of suppliers) {
    app.get(`/supplier${supplier}/hotels`, (req, res) => {
      const outage = parseOutage(req.get('X-Mock-Outage'));
      if (outage === supplier || outage === 'both') {
        res.status(503).json({ error: { code: 'SUPPLIER_UNAVAILABLE', message: `Supplier ${supplier} is unavailable.` } });
        return;
      }
      const city = req.query.city === undefined ? undefined : parseCity(req.query.city);
      res.json(city ? inventory[supplier].filter(hotel => normalize(hotel.city) === city) : inventory[supplier]);
    });
  }

  app.get('/health', async (req, res) => {
    const outage = parseOutage(req.get('X-Mock-Outage'));
    const [a, b] = await Promise.all([probeSupplier('A', outage), probeSupplier('B', outage)]);
    const status = a.status === b.status ? (a.status === 'up' ? 'healthy' : 'unavailable') : 'degraded';
    res.status(status === 'healthy' ? 200 : 503).json({ status, suppliers: { 'Supplier A': a, 'Supplier B': b } });
  });

  app.get('/api/hotels', async (req, res) => {
    const search = parseSearch(req.query, req.get('X-Mock-Outage'));
    const workflowId = `hotels-${randomUUID()}`;
    res.set('X-Workflow-Id', workflowId);
    const startDeadline = Date.now() + workflowStartTimeoutMs;
    let workflowStarted = false;
    try {
      const handle = await connection.withDeadline(startDeadline, () =>
        client.workflow.start<typeof compareHotelOffers>('compareHotelOffers', {
          taskQueue: config.taskQueue, workflowId, args: [search], workflowExecutionTimeout: workflowExecutionTimeoutMs
        })
      );
      workflowStarted = true;
      const result = await connection.withDeadline(startDeadline + workflowExecutionTimeoutMs, () => handle.result());
      if (result.unavailable.length) {
        res.set('X-Unavailable-Suppliers', result.unavailable.map(s => `Supplier ${s}`).join(', '));
      }
      res.json(result.offers);
    } catch (error) {
      console.error(JSON.stringify({ event: 'search.failed', workflowId, reason: errorMessage(error) }));
      const cause = error instanceof WorkflowFailedError ? error.cause : undefined;
      if (cause instanceof ApplicationFailure && cause.type === 'SuppliersUnavailable') {
        res.status(503).json({ error: { code: 'SUPPLIERS_UNAVAILABLE', message: 'Both suppliers are unavailable.' } });
      } else if (cause instanceof ApplicationFailure && cause.type === 'StorageUnavailable') {
        res.status(503).json({ error: { code: 'STORAGE_UNAVAILABLE', message: 'Offer storage is unavailable.' } });
      } else if (cause instanceof TimeoutFailure || (workflowStarted && isGrpcDeadlineError(error))) {
        res.status(504).json({ error: { code: 'SEARCH_TIMEOUT', message: 'Hotel search timed out.' } });
      } else {
        res.status(503).json({ error: { code: 'SEARCH_UNAVAILABLE', message: 'Hotel search is temporarily unavailable.' } });
      }
    }
  });

  app.use((_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Endpoint not found.' } }));
  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof InputError) {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: error.message } });
      return;
    }
    console.error(JSON.stringify({ event: 'api.error', reason: errorMessage(error) }));
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Unexpected server error.' } });
  };
  app.use(errorHandler);

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
