const { test } = require('node:test');
const assert = require('node:assert');

const { summarizeBans, summarizeWars } = require('../src/stats');

// Fixed "now" so active/expired classification is deterministic.
const NOW = Date.parse('2026-06-11T00:00:00Z');

function ban(overrides) {
  return { date: '2026-06-01', severity: 'HIGH', duration: 'Permanent', staff_member: 'Mod', ban_id: 'ID: 1', ...overrides };
}

test('summarizeBans tallies severity and total', () => {
  const out = summarizeBans([
    ban({ severity: 'LOW' }),
    ban({ severity: 'high' }),   // case-insensitive
    ban({ severity: 'HIGH' }),
  ]);
  assert.strictEqual(out.total, 3);
  assert.strictEqual(out.severity.LOW, 1);
  assert.strictEqual(out.severity.HIGH, 2);
});

test('summarizeBans classifies active / expired / lifted', () => {
  // Patch Date.now so computeBanEnd uses our fixed NOW.
  const realNow = Date.now;
  Date.now = () => NOW;
  try {
    const out = summarizeBans(
      [
        ban({ ban_id: 'ID: 1', duration: 'Permanent' }),          // active (permanent)
        ban({ ban_id: 'ID: 2', date: '2026-06-01', duration: '3d' }), // expired (ended 06-04)
        ban({ ban_id: 'ID: 3', date: '2026-06-01', duration: '30d' }),// active (ends 07-01)
        ban({ ban_id: 'ID: 4', duration: 'Permanent' }),          // lifted (overridden below)
      ],
      banId => banId === 'ID: 4',
    );
    assert.strictEqual(out.lifted, 1);
    assert.strictEqual(out.expired, 1);
    assert.strictEqual(out.active, 2);
  } finally {
    Date.now = realNow;
  }
});

test('summarizeBans ranks top staff (max 5)', () => {
  const bans = [];
  for (let i = 0; i < 3; i++) bans.push(ban({ staff_member: 'Alice' }));
  for (let i = 0; i < 5; i++) bans.push(ban({ staff_member: 'Bob' }));
  bans.push(ban({ staff_member: 'Carol' }));
  const out = summarizeBans(bans);
  assert.strictEqual(out.topStaff[0][0], 'Bob');
  assert.strictEqual(out.topStaff[0][1], 5);
  assert.strictEqual(out.topStaff[1][0], 'Alice');
  assert.ok(out.topStaff.length <= 5);
});

test('summarizeWars tallies status and type case-insensitively', () => {
  const out = summarizeWars([
    { status: 'APPROVED', type: 'War' },
    { status: 'approved', type: 'raid' },
    { status: 'PENDING', type: 'RAID' },
  ]);
  assert.strictEqual(out.total, 3);
  assert.strictEqual(out.status.APPROVED, 2);
  assert.strictEqual(out.status.PENDING, 1);
  assert.strictEqual(out.type.war, 1);
  assert.strictEqual(out.type.raid, 2);
});
