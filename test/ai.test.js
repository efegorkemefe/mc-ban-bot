const { test } = require('node:test');
const assert = require('node:assert');

const { extractJson } = require('../src/ai');

test('extractJson pulls a JSON object out of surrounding prose', () => {
  const out = extractJson('Here is my verdict: {"decision":"approve","confidence":"high"} — done.');
  assert.deepStrictEqual(out, { decision: 'approve', confidence: 'high' });
});

test('extractJson returns null when there is no JSON', () => {
  assert.strictEqual(extractJson('no json here'), null);
  assert.strictEqual(extractJson(''), null);
  assert.strictEqual(extractJson(null), null);
});

test('extractJson returns null for malformed JSON', () => {
  assert.strictEqual(extractJson('{not valid json}'), null);
});
