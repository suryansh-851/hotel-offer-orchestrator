const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { parseMockOutage, parseSearchOutage, outageForAttempt } = require('../dist/faults');
const { parseOutage, parseSearch, InputError } = require('../dist/query');

test('with faults enabled the header selects an outage, and unknown values are unsupported', () => {
  assert.equal(parseMockOutage(undefined, true), undefined);
  for (const value of ['A', 'B', 'both']) assert.equal(parseMockOutage(value, true), value);
  for (const value of ['B-once', 'C', 'a', '', 'both ']) assert.equal(parseMockOutage(value, true), 'unsupported', value);
  assert.equal(parseSearchOutage('B-once', true), 'B-once');
  assert.equal(parseSearchOutage('C', true), 'unsupported');
});

test('with faults disabled every header value is ignored, valid or not', () => {
  for (const value of [undefined, 'A', 'B', 'both', 'B-once', 'C', '']) {
    assert.equal(parseMockOutage(value, false), undefined, String(value));
    assert.equal(parseSearchOutage(value, false), undefined, String(value));
    assert.equal(parseOutage(value, false), undefined, String(value));
  }
});

test('B-once fails Supplier B on the first attempt only', () => {
  assert.equal(outageForAttempt('B-once', 1), 'B');
  assert.equal(outageForAttempt('B-once', 2), undefined);
  assert.equal(outageForAttempt('B-once', 3), undefined);
  assert.equal(outageForAttempt('A', 3), 'A');
  assert.equal(outageForAttempt('both', 1), 'both');
  assert.equal(outageForAttempt(undefined, 1), undefined);
});

test('supplier endpoints reject B-once, which only a search accepts', () => {
  assert.equal(parseOutage('both', true), 'both');
  assert.throws(() => parseOutage('B-once', true), InputError);
  assert.throws(() => parseOutage('C', true), InputError);
});

test('a search keeps the outage out of the workflow input when faults are disabled', () => {
  for (const header of ['A', 'B-once', 'C', undefined]) {
    const search = parseSearch({ city: 'Delhi' }, header);
    assert.equal(Object.hasOwn(search, 'outage'), false, String(header));
    assert.equal(JSON.stringify(search).includes('outage'), false, String(header));
  }
  assert.equal(parseSearch({ city: 'Delhi' }, 'B-once', true).outage, 'B-once');
  assert.throws(() => parseSearch({ city: 'Delhi' }, 'C', true), InputError);
});

test('ENABLE_MOCK_FAULTS defaults to off and only "true" or "1" turn it on', () => {
  const read = value => {
    const env = { ...process.env };
    delete env.ENABLE_MOCK_FAULTS;
    if (value !== undefined) env.ENABLE_MOCK_FAULTS = value;
    return execFileSync(process.execPath, ['-p', "require('./dist/config').config.enableMockFaults"], { env, encoding: 'utf8' }).trim();
  };
  assert.equal(read(undefined), 'false');
  for (const value of ['true', 'TRUE', '1']) assert.equal(read(value), 'true', value);
  for (const value of ['', 'false', '0', 'yes', 'on']) assert.equal(read(value), 'false', value);
});
