const test = require('node:test');
const assert = require('node:assert/strict');
const { createJsonLogger, formatLogEntry } = require('../dist/logging');

test('a log entry is one JSON line shaped like the API logs: event first, then fields', () => {
  const line = formatLogEntry({
    message: 'supplier.received', level: 'INFO', timestampNanos: 1n,
    meta: { sdkComponent: 'activity', workflowId: 'hotels-1', supplier: 'A', city: 'delhi', count: 3, taskToken: 'AAAA==' }
  });
  assert.equal(line.includes('\n'), false);
  assert.deepEqual(JSON.parse(line), {
    event: 'supplier.received', level: 'info', sdkComponent: 'activity', workflowId: 'hotels-1', supplier: 'A', city: 'delhi', count: 3
  });
  assert.ok(line.startsWith('{"event":"supplier.received","level":"info"'));
});

test('entries without metadata, with newlines, bigints or errors still serialize to a single line', () => {
  assert.deepEqual(JSON.parse(formatLogEntry({ message: 'worker.ready', level: 'WARN', timestampNanos: 1n })), { event: 'worker.ready', level: 'warn' });
  const line = formatLogEntry({
    message: 'multi\nline', level: 'ERROR', timestampNanos: 1n,
    meta: { attempt: 2n, reason: new Error('boom'), text: 'a\nb' }
  });
  assert.equal(line.includes('\n'), false);
  assert.deepEqual(JSON.parse(line), { event: 'multi\nline', level: 'error', attempt: '2', reason: { name: 'Error', message: 'boom' }, text: 'a\nb' });
});

test('warnings and errors go to stderr, everything else to stdout, and debug is dropped', () => {
  const written = [];
  const logger = createJsonLogger((stream, line) => written.push([stream, JSON.parse(line)]));
  logger.debug('dropped');
  logger.info('search.started', { city: 'delhi' });
  logger.warn('supplier.unavailable', { supplier: 'B' });
  logger.error('redis.failed', { key: 'k' });
  assert.deepEqual(written, [
    ['stdout', { event: 'search.started', level: 'info', city: 'delhi' }],
    ['stderr', { event: 'supplier.unavailable', level: 'warn', supplier: 'B' }],
    ['stderr', { event: 'redis.failed', level: 'error', key: 'k' }]
  ]);
});
