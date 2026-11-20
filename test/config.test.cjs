const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');
const configVariables = ['PORT', 'ENABLE_MOCK_FAULTS', 'WORKER_HEALTH_PORT', 'TEMPORAL_ADDRESS', 'TEMPORAL_NAMESPACE', 'REDIS_URL', 'SUPPLIER_BASE_URL'];

/**
 * config.ts reads process.env once, when it loads. So each case loads it in a fresh process whose
 * environment is exactly the given one, and returns the config it built or the error it threw.
 */
function loadConfig(env = {}) {
  const inherited = { ...process.env };
  for (const name of configVariables) delete inherited[name];
  const script = "try { console.log(JSON.stringify(require('./dist/config').config)); } catch (e) { console.log(JSON.stringify({ error: e.message })); }";
  return JSON.parse(execFileSync(process.execPath, ['-e', script], { cwd: root, env: { ...inherited, ...env }, encoding: 'utf8' }));
}

test('defaults suit a local run, and the fault flag is off', () => {
  assert.deepEqual(loadConfig(), {
    port: 3000,
    enableMockFaults: false,
    temporalAddress: '127.0.0.1:7233',
    namespace: 'default',
    taskQueue: 'hotel-offers',
    redisUrl: 'redis://127.0.0.1:6379',
    supplierBaseUrl: 'http://127.0.0.1:3000',
    snapshotTtlSeconds: 600
  });
});

test('mock faults are on only for "true" or "1" in any case', () => {
  for (const value of ['true', 'TRUE', 'True', '1']) assert.equal(loadConfig({ ENABLE_MOCK_FAULTS: value }).enableMockFaults, true, value);
  for (const value of ['', 'false', '0', 'yes', 'on', ' true']) assert.equal(loadConfig({ ENABLE_MOCK_FAULTS: value }).enableMockFaults, false, JSON.stringify(value));
});

test('PORT must be a whole number from 1 to 65535, and the supplier URL follows it', () => {
  const config = loadConfig({ PORT: '8080' });
  assert.equal(config.port, 8080);
  assert.equal(config.supplierBaseUrl, 'http://127.0.0.1:8080');
  assert.equal(loadConfig({ PORT: '8080', SUPPLIER_BASE_URL: 'http://supplier.test' }).supplierBaseUrl, 'http://supplier.test');
  for (const value of ['0', '65536', '-1', '3000.5', 'abc', '']) {
    assert.deepEqual(loadConfig({ PORT: value }), { error: 'PORT must be 1–65535' }, JSON.stringify(value));
  }
});

test('WORKER_HEALTH_PORT is optional, and validated when set', () => {
  assert.equal(loadConfig().workerHealthPort, undefined);
  assert.equal(loadConfig({ WORKER_HEALTH_PORT: '8081' }).workerHealthPort, 8081);
  assert.deepEqual(loadConfig({ WORKER_HEALTH_PORT: 'nope' }), { error: 'WORKER_HEALTH_PORT must be 1–65535' });
});
