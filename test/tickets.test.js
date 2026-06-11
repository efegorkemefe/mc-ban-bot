const { test } = require('node:test');
const assert = require('node:assert');

const { encodeTopic, decodeTopic, humanizeDuration } = require('../src/tickets');

test('encodeTopic / decodeTopic round-trips ticket metadata', () => {
  const topic = encodeTopic({ type: 'support', ownerId: '123', claimedBy: '456', status: 'open' });
  const meta = decodeTopic(topic);
  assert.strictEqual(meta.type, 'support');
  assert.strictEqual(meta.ownerId, '123');
  assert.strictEqual(meta.claimedBy, '456');
  assert.strictEqual(meta.status, 'open');
});

test('decodeTopic treats "none" as no claimer', () => {
  const topic = encodeTopic({ type: 'whitelist', ownerId: '789', claimedBy: null, status: 'open' });
  assert.strictEqual(decodeTopic(topic).claimedBy, null);
});

test('decodeTopic returns null for non-ticket topics', () => {
  assert.strictEqual(decodeTopic(''), null);
  assert.strictEqual(decodeTopic(null), null);
  assert.strictEqual(decodeTopic('just a normal channel topic'), null);
});

test('humanizeDuration shows the largest meaningful unit', () => {
  assert.strictEqual(humanizeDuration(0), '0s');
  assert.strictEqual(humanizeDuration(30_000), '30s');
  assert.strictEqual(humanizeDuration(60_000), '1m');
  assert.strictEqual(humanizeDuration(3_661_000), '1h 1m');
});
