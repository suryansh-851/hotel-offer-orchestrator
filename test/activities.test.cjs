const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createServer } = require('node:http');
const { ApplicationFailure } = require('@temporalio/common');
const { MockActivityEnvironment } = require('@temporalio/testing');

// suppliers.ts and activities.ts read the supplier URL from the environment when they load.
let reply = { status: 200, body: '[]' };
const requests = [];
const server = createServer((req, res) => {
  requests.push({ url: req.url, outage: req.headers['x-mock-outage'] });
  if (reply.hang) return;
  res.writeHead(reply.status, { 'Content-Type': 'application/json' }).end(reply.body);
});
let createActivities;

test.before(async () => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  process.env.SUPPLIER_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  ({ createActivities } = require('../dist/activities'));
});
test.after(() => { server.closeAllConnections(); server.close(); });
test.beforeEach(() => { requests.length = 0; reply = { status: 200, body: '[]' }; });

const row = overrides => ({ hotelId: 'a1', name: 'Holtin', price: 6000, city: 'delhi', commissionPct: 10, ...overrides });
const respond = (status, body) => { reply = { status, body: JSON.stringify(body) }; };

/** An activity environment on a given attempt, with a logger that records what the activity logged. */
function activityEnv(attempt = 1) {
  const logs = [];
  const record = level => (message, meta) => logs.push({ level, message, ...meta });
  const logger = { log: (level, message, meta) => logs.push({ level, message, ...meta }),
    trace: record('TRACE'), debug: record('DEBUG'), info: record('INFO'), warn: record('WARN'), error: record('ERROR') };
  return { env: new MockActivityEnvironment({ attempt }, { logger }), logs };
}

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('expected the activity to fail');
}

test('fetchSupplier returns the supplier and its rows, and logs the count', async () => {
  const { env, logs } = activityEnv();
  respond(200, [row(), row({ hotelId: 'a2', name: 'Radison' })]);
  const result = await env.run(createActivities({}).fetchSupplier, 'A', { city: 'delhi' });
  assert.deepEqual(result, { supplier: 'A', hotels: [row(), row({ hotelId: 'a2', name: 'Radison' })] });
  assert.equal(requests[0].url, '/supplierA/hotels?city=delhi');
  assert.equal(requests[0].outage, undefined, 'no outage header unless the search asked for one');
  assert.ok(logs.some(l => l.message === 'Supplier inventory received' && l.supplier === 'A' && l.count === 2));
});

test('B-once makes only the first attempt carry an outage', async () => {
  respond(200, [row()]);
  const activities = createActivities({});
  for (const [attempt, expected] of [[1, 'B'], [2, undefined], [3, undefined]]) {
    requests.length = 0;
    await activityEnv(attempt).env.run(activities.fetchSupplier, 'B', { city: 'delhi', outage: 'B-once' });
    assert.equal(requests[0].outage, expected, `attempt ${attempt}`);
  }
  requests.length = 0;
  await activityEnv(3).env.run(activities.fetchSupplier, 'A', { city: 'delhi', outage: 'A' });
  assert.equal(requests[0].outage, 'A', 'a plain outage is sent on every attempt');
});

test('a retryable failure is rethrown as is, so Temporal retries it', async () => {
  const { env, logs } = activityEnv(2);
  respond(503, {});
  const error = await rejection(env.run(createActivities({}).fetchSupplier, 'B', { city: 'delhi' }));
  assert.equal(error.message, 'Supplier B returned HTTP 503');
  assert.equal(error instanceof ApplicationFailure && error.nonRetryable, false);
  assert.ok(logs.some(l => l.message === 'Supplier request failed' && l.reason === 'Supplier B returned HTTP 503'));
});

test('a permanent failure becomes a non-retryable ApplicationFailure, so Temporal does not retry it', async () => {
  const activities = createActivities({});
  const permanent = [[400, {}], [404, {}], [200, { not: 'an array' }], [200, [row({ price: -1 })]], [200, [row({ city: 'mumbai' })]]];
  for (const [status, body] of permanent) {
    respond(status, body);
    const error = await rejection(activityEnv().env.run(activities.fetchSupplier, 'B', { city: 'delhi' }));
    assert.ok(error instanceof ApplicationFailure, `${status} ${JSON.stringify(body)}`);
    assert.equal(error.nonRetryable, true, `${status} ${JSON.stringify(body)}`);
    assert.equal(error.type, 'SupplierBadResponse');
    assert.match(error.message, /^Supplier B returned (HTTP 40[04]|invalid inventory)$/);
  }
  for (const status of [408, 429, 500, 502]) {
    respond(status, {});
    const error = await rejection(activityEnv().env.run(activities.fetchSupplier, 'B', { city: 'delhi' }));
    assert.equal(error instanceof ApplicationFailure && error.nonRetryable, false, `HTTP ${status} stays retryable`);
  }
});

test('cancelling an attempt aborts the supplier request instead of waiting for it', async () => {
  const { env } = activityEnv();
  reply = { hang: true };
  const pending = rejection(env.run(createActivities({}).fetchSupplier, 'A', { city: 'delhi' }));
  while (!requests.length) await new Promise(resolve => setTimeout(resolve, 5));
  env.cancel();
  const error = await pending;
  assert.ok(error, 'the attempt ends once the activity is cancelled');
});

/** An in-memory stand-in for the slice of ioredis that storeAndFilter uses. Sorted sets order by score, then member. */
function fakeRedis({ abort = false, replyError, range, rejectWith } = {}) {
  const sets = new Map();
  const log = [];
  const bound = (value, open) => (value === '-inf' ? -Infinity : value === '+inf' ? Infinity : Number(value ?? open));
  return {
    sets, log,
    multi() {
      const ops = [];
      const tx = {
        del: key => (ops.push(['del', key]), tx),
        zadd: (key, ...args) => (ops.push(['zadd', key, ...args]), tx),
        expire: (key, seconds) => (ops.push(['expire', key, seconds]), tx),
        zrangebyscore: (key, min, max) => (ops.push(['zrangebyscore', key, min, max]), tx),
        async exec() {
          if (rejectWith) throw rejectWith;
          if (abort) return null;
          const replies = ops.map(([op, key, ...args]) => {
            log.push([op, key, ...args]);
            if (op === 'del') return [null, sets.delete(key) ? 1 : 0];
            if (op === 'zadd') {
              const members = [];
              for (let i = 0; i < args.length; i += 2) members.push({ score: args[i], member: args[i + 1] });
              sets.set(key, members);
              return [null, members.length];
            }
            if (op === 'expire') return [null, 1];
            const [min, max] = args;
            const inRange = (sets.get(key) ?? []).filter(m => m.score >= bound(min, -Infinity) && m.score <= bound(max, Infinity));
            inRange.sort((a, b) => a.score - b.score || (a.member < b.member ? -1 : 1));
            return [null, range ?? inRange.map(m => m.member)];
          });
          if (replyError) replies[1] = [replyError, undefined];
          return replies;
        }
      };
      return tx;
    }
  };
}

const offer = (name, price, supplier = 'Supplier A') => ({ name, price, supplier, commissionPct: 10 });
const winners = [offer('Lotus Residency', 8100, 'Supplier B'), offer('Holtin', 5340, 'Supplier B'), offer('Radison', 5900)];

test('storeAndFilter stores the full snapshot and returns the inclusive price range in price order', async () => {
  const redis = fakeRedis();
  const { storeAndFilter } = createActivities(redis);
  const run = (search, available = ['A', 'B']) => activityEnv().env.run(storeAndFilter, search, available, winners);

  assert.deepEqual((await run({ city: 'delhi', minPrice: 5340, maxPrice: 5900 })).map(o => o.price), [5340, 5900]);
  assert.equal(redis.sets.get('hotels:v1:delhi:A+B').length, 3, 'the whole set is stored, not just the range');
  assert.deepEqual((await run({ city: 'delhi' })).map(o => o.price), [5340, 5900, 8100]);
  assert.deepEqual((await run({ city: 'delhi', maxPrice: 5340 })).map(o => o.name), ['Holtin']);
  assert.deepEqual((await run({ city: 'delhi', minPrice: 8100 })).map(o => o.name), ['Lotus Residency']);
  assert.deepEqual(await run({ city: 'delhi', minPrice: 6000, maxPrice: 8000 }), []);
  assert.deepEqual((await run({ city: 'delhi', minPrice: 0, maxPrice: 0 })), []);
});

test('storeAndFilter replaces the snapshot atomically, keys it by city and suppliers, and sets the TTL', async () => {
  const redis = fakeRedis();
  const { storeAndFilter } = createActivities(redis);
  await activityEnv().env.run(storeAndFilter, { city: 'new delhi' }, ['A'], winners);
  assert.deepEqual(redis.log.map(([op]) => op), ['del', 'zadd', 'expire', 'zrangebyscore']);
  const [del, zadd, expire, range] = redis.log;
  assert.equal(del[1], 'hotels:v1:new%20delhi:A');
  assert.deepEqual(zadd.slice(2), [8100, JSON.stringify(winners[0]), 5340, JSON.stringify(winners[1]), 5900, JSON.stringify(winners[2])]);
  assert.deepEqual(expire, ['expire', 'hotels:v1:new%20delhi:A', 600]);
  assert.deepEqual(range.slice(2), ['-inf', '+inf']);
});

test('storeAndFilter clears a stale snapshot when the inventory is empty', async () => {
  const redis = fakeRedis();
  redis.sets.set('hotels:v1:atlantis:A+B', [{ score: 1, member: 'stale' }]);
  const result = await activityEnv().env.run(createActivities(redis).storeAndFilter, { city: 'atlantis' }, ['A', 'B'], []);
  assert.deepEqual(result, []);
  assert.equal(redis.sets.has('hotels:v1:atlantis:A+B'), false);
  assert.deepEqual(redis.log.map(([op]) => op), ['del', 'zrangebyscore'], 'nothing is written for an empty set');
});

test('storeAndFilter fails, and logs, when Redis misbehaves', async () => {
  const cases = [
    ['the transaction aborted', fakeRedis({ abort: true }), /Redis transaction aborted/],
    ['a command failed', fakeRedis({ replyError: new Error('READONLY') }), /READONLY/],
    ['the range reply is not a list', fakeRedis({ range: 'oops' }), /Unexpected Redis range response/],
    ['Redis is unreachable', fakeRedis({ rejectWith: new Error('connect ECONNREFUSED') }), /ECONNREFUSED/]
  ];
  for (const [label, redis, pattern] of cases) {
    const { env, logs } = activityEnv();
    const error = await rejection(env.run(createActivities(redis).storeAndFilter, { city: 'delhi' }, ['A', 'B'], winners));
    assert.match(error.message, pattern, label);
    assert.ok(logs.some(l => l.message === 'Redis snapshot failed' && l.level === 'ERROR'), label);
  }
});
