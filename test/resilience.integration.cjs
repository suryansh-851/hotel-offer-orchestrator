const { execFile } = require('node:child_process');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { promisify } = require('node:util');
const assert = require('node:assert/strict');

const run = promisify(execFile);
const baseUrl = process.env.API_BASE_URL ?? `http://127.0.0.1:${process.env.API_PORT ?? 3000}`;
const searchUrl = new URL('/api/hotels?city=delhi', baseUrl);

async function compose(...args) {
  const { stdout } = await run('docker', ['compose', ...args], { timeout: 120000 });
  return stdout.trim();
}

async function workerReadiness(expectedStatus) {
  const status = await compose('exec', '-T', 'worker', 'node', '--input-type=module', '-e', `
    const url = 'http://127.0.0.1:' + process.env.WORKER_HEALTH_PORT + '/ready';
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    console.log(response.status);
  `);
  assert.equal(Number(status), expectedStatus, 'Worker readiness status');
}

async function searchError(expectedStatus, expectedCode, timeoutMs = 40000) {
  const response = await fetch(searchUrl, { signal: AbortSignal.timeout(timeoutMs) });
  const body = await response.json();
  assert.equal(response.status, expectedStatus, JSON.stringify(body));
  assert.equal(body.error?.code, expectedCode);
}

async function restoreAndVerify(command, service) {
  await compose(command, service);
  const deadline = Date.now() + 30000;
  for (;;) {
    try {
      await workerReadiness(200);
      break;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await delay(500);
    }
  }
  const response = await fetch(searchUrl, { signal: AbortSignal.timeout(40000) });
  const offers = await response.json();
  assert.equal(response.status, 200, JSON.stringify(offers));
  assert.deepEqual(offers.map(offer => offer.price), [5340, 5900, 7200, 8100]);
}

test('a stalled Temporal server makes the worker unready and search unavailable', async t => {
  await workerReadiness(200);
  await compose('pause', 'temporal');
  t.after(() => restoreAndVerify('unpause', 'temporal'));

  await workerReadiness(503);
  await searchError(503, 'SEARCH_UNAVAILABLE', 10000);
  const health = await fetch(new URL('/health', baseUrl), { signal: AbortSignal.timeout(5000) });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, 'healthy');
});

test('an offline Redis reports unavailable storage and makes the worker unready', async t => {
  await compose('stop', 'redis');
  t.after(() => restoreAndVerify('start', 'redis'));

  await workerReadiness(503);
  await searchError(503, 'STORAGE_UNAVAILABLE');
});

test('a started search times out while its worker is stopped', async t => {
  await compose('stop', 'worker');
  t.after(() => restoreAndVerify('start', 'worker'));

  await searchError(504, 'SEARCH_TIMEOUT');
});
