import { randomUUID } from 'node:crypto';
import express, { type ErrorRequestHandler } from 'express';
import { normalize, suppliers, type Search, type Supplier, type SupplierHotel } from './domain';
import { InputError, parseCity, parseOutage, parseSearch } from './query';
import { SearchError, searchUnavailable, type SearchResult } from './search';
import { errorMessage, type probeSupplier } from './suppliers';

/** Everything the HTTP layer needs from the outside, so tests can supply fakes. */
export interface AppDeps {
  /** Demo only: honour the X-Mock-Outage header. */
  enableMockFaults: boolean;
  /** Rows served by the mock supplier endpoints. */
  inventory: Record<Supplier, SupplierHotel[]>;
  probeSupplier: typeof probeSupplier;
  /** Runs one search through Temporal. Rejects with a SearchError. */
  search(search: Search, workflowId: string): Promise<SearchResult>;
  /** Writes one structured log entry. Defaults to a JSON line on stderr. */
  log?(entry: Record<string, unknown>): void;
}

export function createApp(deps: AppDeps) {
  const { enableMockFaults, inventory, probeSupplier: probe, search: runSearch } = deps;
  const log = deps.log ?? (entry => console.error(JSON.stringify(entry)));
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  app.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  for (const supplier of suppliers) {
    app.get(`/supplier${supplier}/hotels`, (req, res) => {
      const outage = parseOutage(req.get('X-Mock-Outage'), enableMockFaults);
      if (outage === supplier || outage === 'both') {
        res.status(503).json({ error: { code: 'SUPPLIER_UNAVAILABLE', message: `Supplier ${supplier} is unavailable.` } });
        return;
      }
      const city = req.query.city === undefined ? undefined : parseCity(req.query.city);
      res.json(city ? inventory[supplier].filter(hotel => normalize(hotel.city) === city) : inventory[supplier]);
    });
  }

  app.get('/health', async (req, res) => {
    const outage = parseOutage(req.get('X-Mock-Outage'), enableMockFaults);
    const [a, b] = await Promise.all([probe('A', outage), probe('B', outage)]);
    const status = a.status === b.status ? (a.status === 'up' ? 'healthy' : 'unavailable') : 'degraded';
    res.status(status === 'healthy' ? 200 : 503).json({ status, suppliers: { 'Supplier A': a, 'Supplier B': b } });
  });

  app.get('/api/hotels', async (req, res) => {
    const search = parseSearch(req.query, req.get('X-Mock-Outage'), enableMockFaults);
    const workflowId = `hotels-${randomUUID()}`;
    res.set('X-Workflow-Id', workflowId);
    try {
      const result = await runSearch(search, workflowId);
      if (result.unavailable.length) {
        res.set('X-Unavailable-Suppliers', result.unavailable.map(s => `Supplier ${s}`).join(', '));
      }
      res.json(result.offers);
    } catch (error) {
      const failure = error instanceof SearchError ? error : searchUnavailable(error);
      log({ event: 'search.failed', workflowId, reason: errorMessage(failure.cause ?? failure) });
      res.status(failure.status).json({ error: { code: failure.code, message: failure.message } });
    }
  });

  app.use((_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Endpoint not found.' } }));
  // Express 5 forwards a rejected async handler here, which is how a bad query on /api/hotels becomes a 400.
  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof InputError) {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: error.message } });
      return;
    }
    log({ event: 'api.error', reason: errorMessage(error) });
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Unexpected server error.' } });
  };
  app.use(errorHandler);
  return app;
}
