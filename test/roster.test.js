const { test } = require('node:test');
const assert = require('node:assert');

// Configure the tier roles + thresholds the helpers read from process.env. The
// roster config readers parse process.env fresh on every call, so setting these
// before (or after) requiring the module both work — and each test file runs in
// its own process, so this never leaks into the other suites.
process.env.STAFF_ROLE_IDS = 'r_staff';
process.env.SENIOR_ROLE_IDS = 'r_senior';
process.env.SUPER_ROLE_IDS = 'r_super';
process.env.STAFF_EXEMPT_ROLE_ID = 'r_exempt';
process.env.PROMO_MIN_TENURE_DAYS = '30';
process.env.PROMO_QUOTA_WEEKS_REQUIRED = '6';
process.env.PROMO_QUOTA_WEEKS_WINDOW = '8';
process.env.PROMO_MAX_WARNS = '2';
process.env.PROMO_MIN_LIFETIME_ACTIONS = '0';
process.env.WEEKLY_QUOTA_BANS = '0';
process.env.WEEKLY_QUOTA_WARS = '0';
process.env.WEEKLY_QUOTA_TICKETS = '0';
process.env.WEEKLY_QUOTA_WARNS = '0';

const roster = require('../src/roster');

const DAY = 86_400_000;

// Minimal GuildMember stand-in. `admin` drives the Administrator permission check
// (our mock returns it for any permission query, which is all getStaffTier needs).
function member({ roles = [], admin = false } = {}) {
  const set = new Set(roles);
  return {
    permissions: { has: () => admin },
    roles: { cache: { has: id => set.has(id) } },
  };
}

// ── getStaffTier / roleTier ─────────────────────────────────────────────────────
test('getStaffTier: no roles → 0', () => {
  assert.strictEqual(roster.getStaffTier(member()), 0);
});

test('getStaffTier: staff/senior/super roles → 1/2/3', () => {
  assert.strictEqual(roster.getStaffTier(member({ roles: ['r_staff'] })), 1);
  assert.strictEqual(roster.getStaffTier(member({ roles: ['r_senior'] })), 2);
  assert.strictEqual(roster.getStaffTier(member({ roles: ['r_super'] })), 3);
});

test('getStaffTier: highest tier role wins', () => {
  assert.strictEqual(roster.getStaffTier(member({ roles: ['r_staff', 'r_senior'] })), 2);
  assert.strictEqual(roster.getStaffTier(member({ roles: ['r_staff', 'r_super'] })), 3);
});

test('getStaffTier: Administrator ⇒ tier 3 regardless of roles', () => {
  assert.strictEqual(roster.getStaffTier(member({ admin: true })), 3);
  assert.strictEqual(roster.getStaffTier(member({ roles: ['r_staff'], admin: true })), 3);
});

test('getStaffTier: null member → 0', () => {
  assert.strictEqual(roster.getStaffTier(null), 0);
});

test('roleTier: ignores the Administrator fallback', () => {
  assert.strictEqual(roster.roleTier(member({ admin: true })), 0);
  assert.strictEqual(roster.roleTier(member({ roles: ['r_senior'], admin: true })), 2);
});

test('canActOn: strictly greater tier only', () => {
  assert.strictEqual(roster.canActOn(3, 2), true);
  assert.strictEqual(roster.canActOn(3, 3), false);
  assert.strictEqual(roster.canActOn(2, 3), false);
});

// ── isExempt (the single exemption gate) ────────────────────────────────────────
test('isExempt: LOA or suspended status → true', () => {
  assert.strictEqual(roster.isExempt({ status: 'loa' }, member()), true);
  assert.strictEqual(roster.isExempt({ status: 'suspended' }, member()), true);
});

test('isExempt: active + exempt role → true', () => {
  assert.strictEqual(roster.isExempt({ status: 'active' }, member({ roles: ['r_exempt'] })), true);
});

test('isExempt: active + no exempt role → false', () => {
  assert.strictEqual(roster.isExempt({ status: 'active' }, member({ roles: ['r_staff'] })), false);
  assert.strictEqual(roster.isExempt({ status: 'active' }, null), false);
});

// ── effectiveTenureDays (LOA / suspension pause the clock) ───────────────────────
test('effectiveTenureDays: excludes accumulated paused time', () => {
  const now = Date.now();
  const e = { tenureStart: new Date(now - 40 * DAY).toISOString(), tenurePausedMs: 10 * DAY, pauseStartedAt: null };
  assert.strictEqual(roster.effectiveTenureDays(e, now), 30);
});

test('effectiveTenureDays: subtracts a currently-running pause', () => {
  const now = Date.now();
  const e = { tenureStart: new Date(now - 40 * DAY).toISOString(), tenurePausedMs: 0, pauseStartedAt: new Date(now - 5 * DAY).toISOString() };
  assert.strictEqual(roster.effectiveTenureDays(e, now), 35);
});

// ── meetsQuota ──────────────────────────────────────────────────────────────────
test('meetsQuota: all-zero quotas pass vacuously', () => {
  assert.strictEqual(roster.meetsQuota({ bans: 0, wars: 0, tickets: 0, warnsIssued: 0 }), true);
});

test('meetsQuota: only non-zero quotas are enforced', () => {
  process.env.WEEKLY_QUOTA_BANS = '3';
  try {
    assert.strictEqual(roster.meetsQuota({ bans: 2 }), false);
    assert.strictEqual(roster.meetsQuota({ bans: 3 }), true);
  } finally {
    process.env.WEEKLY_QUOTA_BANS = '0';
  }
});

// ── computeEligibility ──────────────────────────────────────────────────────────
function passedWeeks(n) {
  return Array.from({ length: n }, (_, i) => ({ weekStart: `w${i}`, passed: true, counters: {} }));
}

function eligibleEntry(now, over = {}) {
  return {
    tier: 1,
    tenureStart: new Date(now - 40 * DAY).toISOString(),
    tenurePausedMs: 0,
    pauseStartedAt: null,
    warns: [],
    strikes: [],
    lifetime: { bans: 5, wars: 0, tickets: 0, warnsIssued: 0 },
    history: passedWeeks(8),
    status: 'active',
    ...over,
  };
}

test('computeEligibility: all criteria met → eligible, no reasons', () => {
  const now = Date.now();
  const r = roster.computeEligibility(eligibleEntry(now), { now });
  assert.strictEqual(r.eligible, true);
  assert.deepStrictEqual(r.reasons, []);
});

test('computeEligibility: short tenure blocks', () => {
  const now = Date.now();
  const e = eligibleEntry(now, { tenureStart: new Date(now - 10 * DAY).toISOString() });
  const r = roster.computeEligibility(e, { now });
  assert.strictEqual(r.eligible, false);
  assert.strictEqual(r.tenureOk, false);
});

test('computeEligibility: an active strike blocks, a pardoned one does not', () => {
  const now = Date.now();
  assert.strictEqual(roster.computeEligibility(eligibleEntry(now, { strikes: [{ id: 's1', pardoned: false }] }), { now }).eligible, false);
  assert.strictEqual(roster.computeEligibility(eligibleEntry(now, { strikes: [{ id: 's1', pardoned: true }] }), { now }).eligible, true);
});

test('computeEligibility: active warns at the max blocks (must be < PROMO_MAX_WARNS)', () => {
  const now = Date.now();
  const e = eligibleEntry(now, { warns: [{ id: 'w1', pardoned: false }, { id: 'w2', pardoned: false }] });
  assert.strictEqual(roster.computeEligibility(e, { now }).eligible, false);
});

test('computeEligibility: insufficient passed weeks blocks', () => {
  const now = Date.now();
  const r = roster.computeEligibility(eligibleEntry(now, { history: passedWeeks(5) }), { now });
  assert.strictEqual(r.eligible, false);
  assert.strictEqual(r.quotaOk, false);
});

test('computeEligibility: LOA / suspended are never eligible', () => {
  const now = Date.now();
  assert.strictEqual(roster.computeEligibility(eligibleEntry(now, { status: 'loa' }), { now }).eligible, false);
  assert.strictEqual(roster.computeEligibility(eligibleEntry(now, { status: 'suspended' }), { now }).eligible, false);
});
