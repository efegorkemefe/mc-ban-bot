const { test } = require('node:test');
const assert = require('node:assert');

const { parseEvidence } = require('../src/embeds');

test('parseEvidence returns an empty array for blank input', () => {
  assert.deepStrictEqual(parseEvidence(''), []);
  assert.deepStrictEqual(parseEvidence(null), []);
});

test('parseEvidence splits on newlines and commas and trims', () => {
  assert.deepStrictEqual(parseEvidence('a\nb, c'), ['a', 'b', 'c']);
});

test('parseEvidence keeps a single link intact', () => {
  assert.deepStrictEqual(
    parseEvidence('https://discord.com/channels/1/2/3'),
    ['https://discord.com/channels/1/2/3'],
  );
});
