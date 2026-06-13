const { test } = require('node:test');
const assert = require('node:assert');

const { startOfWeek, tallyByName, weeklyStaffReport, banLeaderboard } = require('../src/report');

test('startOfWeek returns the Monday 00:00 of the containing week', () => {
  // 2026-06-10 is a Wednesday.
  const mon = startOfWeek(new Date('2026-06-10T15:30:00'));
  assert.strictEqual(mon.getDay(), 1);        // Monday
  assert.strictEqual(mon.getHours(), 0);
  assert.strictEqual(mon.getMinutes(), 0);
  // Sunday belongs to the week that started the previous Monday.
  const sun = startOfWeek(new Date('2026-06-14T23:00:00')); // Sunday
  assert.strictEqual(sun.getDay(), 1);
  assert.strictEqual(sun.getDate(), 8);       // Mon 2026-06-08
});

test('tallyByName counts per name and honours the date window', () => {
  const items = [
    { who: 'Alice', d: '2026-06-09' },
    { who: 'Alice', d: '2026-06-09' },
    { who: 'Bob', d: '2026-06-02' },
    { who: '', d: '2026-06-09' },             // blank name ignored
  ];
  assert.deepStrictEqual(tallyByName(items, 'who', 'd'), { Alice: 2, Bob: 1 });
  const windowed = tallyByName(items, 'who', 'd', Date.parse('2026-06-08'), Date.parse('2026-06-15'));
  assert.deepStrictEqual(windowed, { Alice: 2 });
});

test('banLeaderboard ranks staff descending', () => {
  const bans = [
    { staff_member: 'Alice', date: '2026-06-09' },
    { staff_member: 'Bob', date: '2026-06-09' },
    { staff_member: 'Bob', date: '2026-06-09' },
  ];
  const all = banLeaderboard(bans, {});
  assert.deepStrictEqual(all[0], ['Bob', 2]);
  assert.deepStrictEqual(all[1], ['Alice', 1]);
});

test('weeklyStaffReport aggregates bans, wars, tickets and avg response', () => {
  const out = weeklyStaffReport({
    bans: [
      { staff_member: 'Alice', date: '2026-06-09' },
      { staff_member: 'Alice', date: '2026-06-01' }, // before window — excluded
    ],
    wars: [{ approved_by: 'Bob', date: '2026-06-10' }],
    closedTickets: [
      { closedByName: 'Alice', closedAt: '2026-06-09T10:00:00Z', firstResponseMs: 60_000 },
      { closedByName: 'Bob', closedAt: '2026-06-10T10:00:00Z', firstResponseMs: 180_000 },
      { closedByName: 'Bob', closedAt: '2026-06-01T10:00:00Z', firstResponseMs: 999 }, // excluded
    ],
    weekStartMs: Date.parse('2026-06-08'),
    weekEndMs: Date.parse('2026-06-15'),
  });
  assert.deepStrictEqual(out.banCounts, [['Alice', 1]]);
  assert.deepStrictEqual(out.warCounts, [['Bob', 1]]);
  assert.strictEqual(out.ticketsClosed, 2);
  assert.strictEqual(out.avgFirstResponseMs, 120_000); // (60k + 180k) / 2
});
