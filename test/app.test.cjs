const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { WorkflowFailedError } = require('@temporalio/client');
const { ApplicationFailure, TimeoutFailure } = require('@temporalio/common');
const { createApp } = require('../dist/app');
const { inventory } = require('../dist/fixtures');
const { SearchError, runSearch } = require('../dist/search');

const offers = [{ name: 'Holtin', price: 5340, supplier: 'Supplier B', commissionPct: 20 }];
const up = { status: 'up', latencyMs: 3 };
const down = reason => ({ status: 'down', latencyMs: 4, reason });

/** Starts the real Express app on a random port with fakes for everything outside HTTP. */
async function serve(t, overrides = {}) {
  const calls = { search: [], probe: [], log: [] };
  const app = createApp({
    enableMockFaults: true,
    inventory,
    probeSupplier: async (supplier, outage) => { calls.probe.push([supplier, outage]); return up; },
    search: async (search, workflowId) => { calls.search.push({ search, workflowId }); return { offers, unavailable: [] }; },
    log: entry => calls.log.push(entry),
    ...overrides
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (path, headers = {}) => {
    const response = await fetch(base + path, { headers });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  return { get, calls };
}

const error = (code, message) => ({ error: { code, message } });
const workflowFailure = cause => new WorkflowFailedError('Workflow execution failed', cause, 'RETRY_STATE_NON_RETRYABLE_FAILURE');
const grpcDeadline = () => Object.assign(new Error('4 DEADLINE_EXCEEDED'), { code: 4, details: 'Deadline exceeded', metadata: {} });

test('validation failures are 400 INVALID_REQUEST, including the async handler that Express 5 rejects', async t => {
  const { get, calls } = await serve(t);
  const bad = [
    ['/api/hotels', 'Supply one non-empty city of up to 80 characters.'],
    ['/api/hotels?city=', 'Supply one non-empty city of up to 80 characters.'],
    ['/api/hotels?city=delhi&city=mumbai', 'Supply one non-empty city of up to 80 characters.'],
    ['/api/hotels?city=delhi&minPrice=-1', 'minPrice must be a non-negative decimal number.'],
    ['/api/hotels?city=delhi&maxPrice=abc', 'maxPrice must be a non-negative decimal number.'],
    ['/api/hotels?city=delhi&minPrice=6000&maxPrice=5999', 'minPrice must be less than or equal to maxPrice.'],
    ['/supplierA/hotels?city=', 'Supply one non-empty city of up to 80 characters.']
  ];
  for (const [path, message] of bad) {
    const response = await get(path);
    assert.equal(response.status, 400, path);
    assert.deepEqual(response.body, error('INVALID_REQUEST', message), path);
  }
  assert.equal(calls.search.length, 0, 'an invalid request never starts a workflow');
  const health = await get('/health', { 'X-Mock-Outage': 'nonsense' });
  assert.equal(health.status, 400, 'the async /health handler rejects through the same error handler');
  assert.deepEqual(health.body, error('INVALID_REQUEST', 'Unsupported X-Mock-Outage value.'));
});

test('unknown routes are 404 and are never cached', async t => {
  const { get } = await serve(t);
  const response = await get('/nope');
  assert.equal(response.status, 404);
  assert.deepEqual(response.body, error('NOT_FOUND', 'Endpoint not found.'));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-powered-by'), null);
});

test('an unexpected failure is a 500 that does not leak the cause', async t => {
  const { get, calls } = await serve(t, { probeSupplier: async () => { throw new Error('secret internal detail'); } });
  const response = await get('/health');
  assert.equal(response.status, 500);
  assert.deepEqual(response.body, error('INTERNAL_ERROR', 'Unexpected server error.'));
  assert.deepEqual(calls.log, [{ event: 'api.error', reason: 'secret internal detail' }]);
});

test('supplier endpoints serve their rows, and filter by a normalized city', async t => {
  const { get } = await serve(t);
  const all = await get('/supplierA/hotels');
  assert.equal(all.status, 200);
  assert.deepEqual(all.body, inventory.A);
  assert.deepEqual(all.body[0], { hotelId: 'a1', name: 'Holtin', price: 6000, city: 'delhi', commissionPct: 10 });
  const delhi = await get('/supplierB/hotels?city=%20DELHI%20');
  assert.deepEqual(delhi.body.map(row => row.name), ['Holtin', 'Radison', 'Lotus Residency']);
  assert.deepEqual((await get('/supplierB/hotels?city=atlantis')).body, []);
  assert.deepEqual((await get('/supplierA/hotels?city=mumbai')).body.map(row => row.hotelId), ['a4']);
});

test('/health is 200 healthy, 503 degraded or 503 unavailable, and names the failing supplier', async t => {
  const status = { A: up, B: up };
  const { get } = await serve(t, { probeSupplier: async supplier => status[supplier] });
  let response = await get('/health');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { status: 'healthy', suppliers: { 'Supplier A': up, 'Supplier B': up } });

  status.B = down('Supplier B returned HTTP 503');
  response = await get('/health');
  assert.equal(response.status, 503);
  assert.equal(response.body.status, 'degraded');
  assert.deepEqual(response.body.suppliers['Supplier B'], down('Supplier B returned HTTP 503'));

  status.A = down('Supplier A returned HTTP 503');
  response = await get('/health');
  assert.equal(response.status, 503);
  assert.equal(response.body.status, 'unavailable');
});

test('with faults enabled X-Mock-Outage drives suppliers, health and search', async t => {
  const { get, calls } = await serve(t, { enableMockFaults: true });
  const supplier = await get('/supplierB/hotels', { 'X-Mock-Outage': 'B' });
  assert.equal(supplier.status, 503);
  assert.deepEqual(supplier.body, error('SUPPLIER_UNAVAILABLE', 'Supplier B is unavailable.'));
  assert.equal((await get('/supplierA/hotels', { 'X-Mock-Outage': 'B' })).status, 200);
  assert.equal((await get('/supplierA/hotels', { 'X-Mock-Outage': 'both' })).status, 503);
  assert.equal((await get('/supplierA/hotels', { 'X-Mock-Outage': 'B-once' })).status, 400, 'only a search accepts B-once');

  await get('/health', { 'X-Mock-Outage': 'both' });
  assert.deepEqual(calls.probe, [['A', 'both'], ['B', 'both']]);

  await get('/api/hotels?city=delhi', { 'X-Mock-Outage': 'B-once' });
  assert.equal(calls.search.at(-1).search.outage, 'B-once');
  const invalid = await get('/api/hotels?city=delhi', { 'X-Mock-Outage': 'C' });
  assert.equal(invalid.status, 400);
});

test('with faults disabled X-Mock-Outage is ignored everywhere and never reaches the workflow input', async t => {
  const { get, calls } = await serve(t, { enableMockFaults: false });
  for (const value of ['A', 'B', 'both', 'B-once', 'nonsense']) {
    const headers = { 'X-Mock-Outage': value };
    assert.equal((await get('/supplierB/hotels', headers)).status, 200, `supplier, ${value}`);
    assert.equal((await get('/health', headers)).status, 200, `health, ${value}`);
    assert.equal((await get('/api/hotels?city=delhi', headers)).status, 200, `search, ${value}`);
  }
  assert.ok(calls.probe.every(([, outage]) => outage === undefined), 'the probe never sees an outage');
  assert.equal(calls.search.length, 5);
  for (const { search } of calls.search) {
    assert.equal(Object.hasOwn(search, 'outage'), false);
    assert.deepEqual(JSON.parse(JSON.stringify(search)), { city: 'delhi' }, 'the payload Temporal receives');
  }
});

test('a search returns the offers and the workflow id, and passes bounds through', async t => {
  const { get, calls } = await serve(t);
  const response = await get('/api/hotels?city=%20New%20%20Delhi&minPrice=5340&maxPrice=5900.5');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, offers);
  assert.equal(response.headers.get('x-unavailable-suppliers'), null);
  assert.match(response.headers.get('x-workflow-id'), /^hotels-[0-9a-f-]{36}$/);
  assert.deepEqual(calls.search[0].search, { city: 'new delhi', minPrice: 5340, maxPrice: 5900.5 });
  assert.equal(calls.search[0].workflowId, response.headers.get('x-workflow-id'));
});

test('a partial result names the suppliers that were unavailable', async t => {
  const { get } = await serve(t, { search: async () => ({ offers, unavailable: ['A', 'B'] }) });
  const response = await get('/api/hotels?city=delhi');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-unavailable-suppliers'), 'Supplier A, Supplier B');
});

test('search failures map to the documented status and error code', async t => {
  const cases = [
    ['both suppliers failed', { result: workflowFailure(ApplicationFailure.nonRetryable('x', 'SuppliersUnavailable')) },
      503, 'SUPPLIERS_UNAVAILABLE', 'Both suppliers are unavailable.'],
    ['Redis failed', { result: workflowFailure(ApplicationFailure.nonRetryable('x', 'StorageUnavailable')) },
      503, 'STORAGE_UNAVAILABLE', 'Offer storage is unavailable.'],
    ['the workflow timed out', { result: workflowFailure(new TimeoutFailure('late')) },
      504, 'SEARCH_TIMEOUT', 'Hotel search timed out.'],
    ['the result deadline passed', { result: grpcDeadline() },
      504, 'SEARCH_TIMEOUT', 'Hotel search timed out.'],
    ['the workflow could not start', { start: new Error('connect ECONNREFUSED') },
      503, 'SEARCH_UNAVAILABLE', 'Hotel search is temporarily unavailable.'],
    ['the start deadline passed, which is never a 504', { start: grpcDeadline() },
      503, 'SEARCH_UNAVAILABLE', 'Hotel search is temporarily unavailable.'],
    ['an unknown workflow failure', { result: workflowFailure(ApplicationFailure.nonRetryable('x', 'Other')) },
      503, 'SEARCH_UNAVAILABLE', 'Hotel search is temporarily unavailable.']
  ];
  for (const [label, failing, status, code, message] of cases) {
    const ports = {
      start: async () => { if (failing.start) throw failing.start; return 'handle'; },
      result: async () => { throw failing.result; }
    };
    const { get, calls } = await serve(t, { search: (search, id) => runSearch(ports, search, id) });
    const response = await get('/api/hotels?city=delhi');
    assert.equal(response.status, status, label);
    assert.deepEqual(response.body, error(code, message), label);
    assert.equal(response.headers.get('x-unavailable-suppliers'), null, label);
    assert.equal(response.headers.get('x-workflow-id'), calls.log[0].workflowId, `${label}: the id is still reported`);
    assert.equal(calls.log[0].event, 'search.failed', label);
  }
});

test('a search runner that throws something unexpected is still a 503 SEARCH_UNAVAILABLE', async t => {
  const { get, calls } = await serve(t, { search: async () => { throw new TypeError('boom'); } });
  const response = await get('/api/hotels?city=delhi');
  assert.equal(response.status, 503);
  assert.deepEqual(response.body, error('SEARCH_UNAVAILABLE', 'Hotel search is temporarily unavailable.'));
  assert.equal(calls.log[0].reason, 'boom');

  const typed = await serve(t, { search: async () => { throw new SearchError(504, 'SEARCH_TIMEOUT', 'Hotel search timed out.'); } });
  assert.equal((await typed.get('/api/hotels?city=delhi')).status, 504);
});
