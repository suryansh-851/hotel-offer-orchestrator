const { test } = require('node:test');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const Redis = require('ioredis');
const { Client, Connection } = require('@temporalio/client');

const baseUrl = process.env.API_BASE_URL ?? process.env.SUPPLIER_BASE_URL ?? 'http://127.0.0.1:3000';
const cityKey = 'hotels:v1:delhi:A+B';

async function search(params, outage) {
  const query = new URLSearchParams(params);
  if (!query.has('city')) query.set('city', 'delhi');
  const response = await fetch(`${baseUrl}/api/hotels?${query}`, {
    headers: outage ? { 'X-Mock-Outage': outage } : {},
    signal: AbortSignal.timeout(40000)
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return { body, workflowId: response.headers.get('X-Workflow-Id'), headers: response.headers };
}

async function temporalClient(t) {
  const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233' });
  t.after(() => connection.close());
  return new Client({ connection, namespace: process.env.TEMPORAL_NAMESPACE ?? 'default' });
}

function scheduledSupplier(attributes) {
  return JSON.parse(Buffer.from(attributes.input.payloads[0].data).toString('utf8'));
}

test('city snapshots stay independent when an empty inventory replaces old offers', async t => {
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
  t.after(() => redis.disconnect());
  const emptyCity = `test-${randomUUID()}`;
  const emptyKey = `hotels:v1:${emptyCity}:A+B`;
  const oldOffer = { name: 'Previous listing', price: 5200, supplier: 'Supplier A', commissionPct: 10 };
  await redis.multi().zadd(emptyKey, oldOffer.price, JSON.stringify(oldOffer)).expire(emptyKey, 60).exec();
  assert.equal(await redis.zcard(emptyKey), 1);

  const [delhi, mumbai, empty] = await Promise.all([
    search('city=Delhi'), search('city=MUMBAI'), search(`city=${emptyCity}`)
  ]);
  assert.deepEqual(empty.body, []);
  assert.equal(await redis.exists(emptyKey), 0);
  assert.deepEqual(delhi.body.map(h => h.price), [5340, 5900, 7200, 8100]);
  assert.deepEqual(mumbai.body, [{ name: 'Harbour House', price: 4800, supplier: 'Supplier A', commissionPct: 12 }]);
  for (const [city, result] of [['delhi', delhi], ['mumbai', mumbai]]) {
    const snapshot = await redis.zrange(`hotels:v1:${city}:A+B`, 0, -1);
    assert.deepEqual(snapshot.map(row => JSON.parse(row)), result.body);
  }
});

test('one search recovers all four Delhi winners after Supplier B returns HTTP 503 once', async t => {
  const client = await temporalClient(t);
  const { body, headers, workflowId } = await search('', 'B-once');
  assert.equal(headers.has('X-Unavailable-Suppliers'), false);
  assert.deepEqual(body, [
    { name: 'Holtin', price: 5340, supplier: 'Supplier B', commissionPct: 20 },
    { name: 'Radison', price: 5900, supplier: 'Supplier A', commissionPct: 13 },
    { name: 'Neem Courtyard', price: 7200, supplier: 'Supplier A', commissionPct: 9 },
    { name: 'Lotus Residency', price: 8100, supplier: 'Supplier B', commissionPct: 11 }
  ]);
  assert.ok(workflowId, 'The response must identify the workflow that served this request');
  const { events } = await client.workflow.getHandle(workflowId).fetchHistory();
  const scheduled = events.filter(e => e.activityTaskScheduledEventAttributes?.activityType.name === 'fetchSupplier');
  assert.deepEqual(scheduled.map(e => scheduledSupplier(e.activityTaskScheduledEventAttributes)).sort(), ['A', 'B']);
  for (const event of scheduled) {
    const supplier = scheduledSupplier(event.activityTaskScheduledEventAttributes);
    const completed = events.map(e => e.activityTaskCompletedEventAttributes)
      .find(a => a && String(a.scheduledEventId) === String(event.eventId));
    assert.ok(completed, `Supplier ${supplier} must complete within the original workflow`);
    const start = events.find(e => String(e.eventId) === String(completed.startedEventId)).activityTaskStartedEventAttributes;
    assert.equal(start.attempt, supplier === 'B' ? 2 : 1);
    if (supplier === 'B') assert.equal(start.lastFailure?.message, 'Supplier B returned HTTP 503');
  }
});

test('Temporal schedules both HTTP activities together and Redis keeps the full snapshot', async t => {
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
  t.after(() => redis.disconnect());
  const client = await temporalClient(t);

  const { body, workflowId } = await search('minPrice=5340&maxPrice=5900');
  assert.deepEqual(body.map(row => row.price), [5340, 5900]);
  const history = await client.workflow.getHandle(workflowId).fetchHistory();
  const fetches = history.events.map(e => e.activityTaskScheduledEventAttributes)
    .filter(a => a?.activityType.name === 'fetchSupplier');
  assert.equal(fetches.length, 2);
  assert.equal(String(fetches[0].workflowTaskCompletedEventId), String(fetches[1].workflowTaskCompletedEventId));
  const scheduledSuppliers = fetches.map(scheduledSupplier);
  assert.deepEqual(scheduledSuppliers.sort(), ['A', 'B']);

  assert.equal(await redis.type(cityKey), 'zset');
  const snapshot = await redis.zrange(cityKey, 0, -1);
  assert.deepEqual(snapshot.map(row => JSON.parse(row).price), [5340, 5900, 7200, 8100]);
  const storedRange = await redis.zrangebyscore(cityKey, 5340, 5900);
  assert.deepEqual(storedRange.map(row => JSON.parse(row)), body);
  const ttl = await redis.ttl(cityKey);
  assert.ok(ttl > 0 && ttl <= 600);

  const [low, high, partial] = await Promise.all([
    search('maxPrice=5400'), search('minPrice=8000'), search('minPrice=5900&maxPrice=6000', 'B')
  ]);
  assert.deepEqual(low.body.map(row => row.name), ['Holtin']);
  assert.deepEqual(high.body.map(row => row.name), ['Lotus Residency']);
  assert.deepEqual(partial.body.map(row => row.name), ['Radison', 'Holtin']);
  assert.equal(await redis.zcard('hotels:v1:delhi:A'), 3);
  assert.deepEqual(await redis.zrange(cityKey, 0, -1), snapshot);

  const partialHistory = await client.workflow.getHandle(partial.workflowId).fetchHistory();
  const failed = partialHistory.events.find(e => e.activityTaskFailedEventAttributes)?.activityTaskFailedEventAttributes;
  assert.ok(failed, 'The simulated outage should record a failed activity');
  const lastAttempt = partialHistory.events.find(e => String(e.eventId) === String(failed.startedEventId));
  assert.equal(lastAttempt.activityTaskStartedEventAttributes.attempt, 3);
  const scheduled = partialHistory.events.find(e => String(e.eventId) === String(failed.scheduledEventId));
  assert.equal(scheduled.activityTaskScheduledEventAttributes.activityType.name, 'fetchSupplier');
  assert.equal(scheduledSupplier(scheduled.activityTaskScheduledEventAttributes), 'B');
});
