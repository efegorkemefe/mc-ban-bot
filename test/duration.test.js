const { test } = require('node:test');
const assert = require('node:assert');

const { isPermanent, parseDurationMs, computeBanEnd } = require('../src/duration');

const DAY = 86_400_000;

test('isPermanent recognises permanent-style durations', () => {
  assert.strictEqual(isPermanent('Permanent'), true);
  assert.strictEqual(isPermanent('perm'), true);
  assert.strictEqual(isPermanent('forever'), true);
  assert.strictEqual(isPermanent('7d'), false);
  assert.strictEqual(isPermanent(''), false);
});

test('parseDurationMs handles common formats', () => {
  assert.strictEqual(parseDurationMs('7d'), 7 * DAY);
  assert.strictEqual(parseDurationMs('2 weeks'), 14 * DAY);
  assert.strictEqual(parseDurationMs('24h'), DAY);
  assert.strictEqual(parseDurationMs('1w 3d'), 10 * DAY);
});

test('parseDurationMs returns null for permanent / unparseable input', () => {
  assert.strictEqual(parseDurationMs('Permanent'), null);
  assert.strictEqual(parseDurationMs('a while'), null);
  assert.strictEqual(parseDurationMs(''), null);
});

test('computeBanEnd classifies permanent / unknown / active / ended', () => {
  assert.deepStrictEqual(computeBanEnd('2026-01-01', 'Permanent'), { state: 'permanent' });
  assert.deepStrictEqual(computeBanEnd('not-a-date', '7d'), { state: 'unknown' });
  assert.deepStrictEqual(computeBanEnd('2026-01-01', 'gibberish'), { state: 'unknown' });

  const now = Date.parse('2026-01-10T00:00:00Z');
  assert.strictEqual(computeBanEnd('2026-01-01', '7d', now).state, 'ended');   // ended 2026-01-08
  assert.strictEqual(computeBanEnd('2026-01-01', '30d', now).state, 'active'); // ends 2026-01-31
});
