const test = require('node:test');
const assert = require('node:assert/strict');
const { WorkflowFailedError } = require('@temporalio/client');
const { ApplicationFailure, TimeoutFailure } = require('@temporalio/common');
const {
  SearchError, runSearch, startTimeoutMs, resultGraceMs, workflowExecutionTimeoutMs
} = require('../dist/search');

const search = { city: 'delhi' };
const offers = [{ name: 'Holtin', price: 5340, supplier: 'Supplier B', commissionPct: 20 }];
const grpcDeadline = () => Object.assign(new Error('4 DEADLINE_EXCEEDED: Deadline exceeded'), {
  code: 4, details: 'Deadline exceeded', metadata: {}
});
const workflowFailure = cause => new WorkflowFailedError('Workflow execution failed', cause, 'RETRY_STATE_NON_RETRYABLE_FAILURE');

/** Fake Temporal ports. `calls` records what runSearch asked for. */
function ports({ start = async () => 'handle', result = async () => ({ offers, unavailable: [] }) } = {}) {
  const calls = { start: [], result: [] };
  return {
    calls,
    start: async (...args) => { calls.start.push(args); return start(...args); },
    result: async (...args) => { calls.result.push(args); return result(...args); }
  };
}

async function failure(fakes) {
  try {
    await runSearch(fakes, search, 'hotels-1');
  } catch (error) {
    assert.ok(error instanceof SearchError, `expected SearchError, got ${error}`);
    return error;
  }
  assert.fail('runSearch should have rejected');
}

test('starts under a short deadline and bounds the result just above the workflow limit', async () => {
  const fakes = ports();
  const clock = [1_000_000, 1_000_050];
  const result = await runSearch(fakes, search, 'hotels-1', () => clock.shift());
  assert.deepEqual(result, { offers, unavailable: [] });
  assert.deepEqual(fakes.calls.start, [[search, 'hotels-1', 1_000_000 + startTimeoutMs]]);
  assert.deepEqual(fakes.calls.result, [['handle', 1_000_050 + workflowExecutionTimeoutMs + resultGraceMs]]);
  assert.ok(startTimeoutMs <= 3000, 'Temporal outages must fail fast');
  assert.ok(resultGraceMs > 0 && resultGraceMs <= 5000, 'the result deadline sits just above the workflow limit');
});

test('every start failure is 503 SEARCH_UNAVAILABLE and never 504', async () => {
  for (const error of [grpcDeadline(), new Error('connect ECONNREFUSED'), workflowFailure(new TimeoutFailure('late'))]) {
    const fakes = ports({ start: async () => { throw error; } });
    const mapped = await failure(fakes);
    assert.equal(mapped.status, 503);
    assert.equal(mapped.code, 'SEARCH_UNAVAILABLE');
    assert.equal(mapped.cause, error);
    assert.equal(fakes.calls.result.length, 0, 'nothing is awaited when the workflow never started');
  }
});

test('result failures map to the documented status and code', async () => {
  const cases = [
    [workflowFailure(ApplicationFailure.nonRetryable('x', 'SuppliersUnavailable')), 503, 'SUPPLIERS_UNAVAILABLE'],
    [workflowFailure(ApplicationFailure.nonRetryable('x', 'StorageUnavailable')), 503, 'STORAGE_UNAVAILABLE'],
    [workflowFailure(new TimeoutFailure('Workflow timed out')), 504, 'SEARCH_TIMEOUT'],
    [grpcDeadline(), 504, 'SEARCH_TIMEOUT'],
    [workflowFailure(ApplicationFailure.nonRetryable('x', 'SomethingElse')), 503, 'SEARCH_UNAVAILABLE'],
    [new Error('unexpected'), 503, 'SEARCH_UNAVAILABLE']
  ];
  for (const [error, status, code] of cases) {
    const mapped = await failure(ports({ result: async () => { throw error; } }));
    assert.deepEqual([mapped.status, mapped.code], [status, code], String(error));
    assert.equal(mapped.cause, error, 'the original error stays available for logging');
  }
});

test('public error messages are stable', async () => {
  const messages = {
    SUPPLIERS_UNAVAILABLE: 'Both suppliers are unavailable.',
    STORAGE_UNAVAILABLE: 'Offer storage is unavailable.',
    SEARCH_TIMEOUT: 'Hotel search timed out.',
    SEARCH_UNAVAILABLE: 'Hotel search is temporarily unavailable.'
  };
  const errors = [
    workflowFailure(ApplicationFailure.nonRetryable('x', 'SuppliersUnavailable')),
    workflowFailure(ApplicationFailure.nonRetryable('x', 'StorageUnavailable')),
    workflowFailure(new TimeoutFailure('late')),
    new Error('boom')
  ];
  for (const error of errors) {
    const mapped = await failure(ports({ result: async () => { throw error; } }));
    assert.equal(mapped.message, messages[mapped.code]);
  }
});
