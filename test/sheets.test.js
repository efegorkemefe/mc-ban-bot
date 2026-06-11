const { test } = require('node:test');
const assert = require('node:assert');

const { normalizeBanId, formatBanId } = require('../src/sheets');

test('normalizeBanId strips the "ID:" prefix and trims', () => {
  assert.strictEqual(normalizeBanId('ID: 004'), '004');
  assert.strictEqual(normalizeBanId('004'), '004');
  assert.strictEqual(normalizeBanId('  id:7 '), '7');
});

test('normalizeBanId handles nullish input', () => {
  assert.strictEqual(normalizeBanId(null), '');
  assert.strictEqual(normalizeBanId(undefined), '');
});

test('formatBanId re-applies the prefix exactly once', () => {
  assert.strictEqual(formatBanId('004'), 'ID: 004');
  assert.strictEqual(formatBanId('ID: 4'), 'ID: 4');
});
