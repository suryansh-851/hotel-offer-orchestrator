const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createServer } = require('node:http');

// A scripted supplier. suppliers.ts reads the base URL from the environment when it loads.
let reply = { status: 200, body: '[]' };
const server = createServer((req, res) => {
  if (reply.reset) {
    req.socket.destroy();
    return;
  }
  res.writeHead(reply.status, { 'Content-Type': 'application/json' }).end(reply.body);
});
let suppliers;

test.before(async () => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  process.env.SUPPLIER_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  suppliers = require('../dist/suppliers');
});
test.after(() => server.close());

const row = overrides => ({ hotelId: 'b1', name: 'Holtin', price: 5340, city: 'delhi', commissionPct: 20, ...overrides });
const respond = (status, body) => { reply = { status, body: typeof body === 'string' ? body : JSON.stringify(body) }; };

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('expected the supplier call to fail');
}

test('only 4xx other than 408 and 429 is treated as permanent', () => {
  for (const status of [400, 401, 403, 404, 410, 422, 451]) assert.equal(suppliers.isRetryableStatus(status), false, `HTTP ${status}`);
  for (const status of [408, 429, 500, 502, 503, 504]) assert.equal(suppliers.isRetryableStatus(status), true, `HTTP ${status}`);
});

test('HTTP failures carry the status and keep the exact message', async () => {
  for (const [status, retryable] of [[503, true], [500, true], [408, true], [429, true], [400, false], [404, false]]) {
    respond(status, { error: 'nope' });
    const error = await rejection(suppliers.fetchHotels('B', 'delhi'));
    assert.ok(error instanceof suppliers.SupplierError, `HTTP ${status}`);
    assert.equal(error.message, `Supplier B returned HTTP ${status}`);
    assert.equal(error.retryable, retryable, `HTTP ${status}`);
  }
});

test('a valid inventory is returned unchanged', async () => {
  const rows = [row(), row({ hotelId: 'b2', name: 'Radison', price: 0, commissionPct: 100 })];
  respond(200, rows);
  assert.deepEqual(await suppliers.fetchHotels('B', 'delhi'), rows);
});

test('schema-invalid payloads are permanent failures', async () => {
  const invalid = {
    'negative price': [row({ price: -1 })],
    'infinite price (1e999 parses to Infinity)': '[{"hotelId":"b1","name":"Holtin","price":1e999,"city":"delhi","commissionPct":20}]',
    'NaN is not JSON': '[{"hotelId":"b1","name":"Holtin","price":NaN,"city":"delhi","commissionPct":20}]',
    'string price': [row({ price: '5340' })],
    'commission over 100': [row({ commissionPct: 100.5 })],
    'negative commission': [row({ commissionPct: -1 })],
    'missing hotelId': [row({ hotelId: undefined })],
    'empty hotelId': [row({ hotelId: '' })],
    'blank name': [row({ name: '   ' })],
    'city mismatch': [row({ city: 'mumbai' })],
    'one bad row among good ones': [row(), row({ price: -5 })],
    'not an array': { hotels: [row()] },
    'null body': 'null',
    'not JSON at all': '<html>bad gateway</html>'
  };
  for (const [label, body] of Object.entries(invalid)) {
    respond(200, body);
    const error = await rejection(suppliers.fetchHotels('A', 'delhi'));
    assert.ok(error instanceof suppliers.SupplierError, label);
    assert.equal(error.message, 'Supplier A returned invalid inventory', label);
    assert.equal(error.retryable, false, label);
  }
});

test('network failures and timeouts are not classified, so Temporal keeps retrying them', async () => {
  reply = { reset: true };
  const reset = await rejection(suppliers.fetchHotels('A', 'delhi'));
  assert.equal(reset instanceof suppliers.SupplierError, false, String(reset));

  respond(200, [row()]);
  const timedOut = await rejection(suppliers.fetchHotels('A', 'delhi', undefined, AbortSignal.abort()));
  assert.equal(timedOut instanceof suppliers.SupplierError, false, String(timedOut));
});

test('probeSupplier reports up with latency, or down with the reason', async () => {
  respond(200, [row()]);
  const up = await suppliers.probeSupplier('A');
  assert.equal(up.status, 'up');
  assert.ok(up.latencyMs >= 0);
  respond(503, {});
  const down = await suppliers.probeSupplier('B');
  assert.equal(down.status, 'down');
  assert.equal(down.reason, 'Supplier B returned HTTP 503');
});
