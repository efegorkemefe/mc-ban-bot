const { test } = require('node:test');
const assert = require('node:assert');

const { extractIgn, formatUuid, IGN_RE } = require('../src/mojang');

test('extractIgn prefers an explicitly labelled username', () => {
  assert.strictEqual(extractIgn('IGN: Steve123\nAge: 14'), 'Steve123');
  assert.strictEqual(extractIgn('my minecraft username is Notch_'), 'Notch_');
  assert.strictEqual(extractIgn('username - CoolGuy'), 'CoolGuy');
  assert.strictEqual(extractIgn('Minecraft name: xX_Dragon_Xx'), 'xX_Dragon_Xx');
});

test('extractIgn falls back to the first plausible token', () => {
  assert.strictEqual(extractIgn('hello my name is BobTheBuilder and im 12'), 'BobTheBuilder');
});

test('extractIgn ignores numbers and common words', () => {
  assert.strictEqual(extractIgn('i am 15 yes original copy'), null);
  assert.strictEqual(extractIgn(''), null);
  assert.strictEqual(extractIgn(null), null);
});

test('IGN_RE enforces Minecraft username rules (3–16, word chars)', () => {
  assert.ok(IGN_RE.test('Steve'));
  assert.ok(IGN_RE.test('a_b_c'));
  assert.ok(!IGN_RE.test('ab'));                 // too short
  assert.ok(!IGN_RE.test('this_name_is_way_too_long'));
  assert.ok(!IGN_RE.test('has space'));
  assert.ok(!IGN_RE.test('bad-dash'));
});

test('formatUuid dashes an undashed Mojang id and leaves others alone', () => {
  assert.strictEqual(formatUuid('069a79f444e94726a5befca90e38aaf5'), '069a79f4-44e9-4726-a5be-fca90e38aaf5');
  assert.strictEqual(formatUuid('already-dashed'), 'already-dashed');
});
