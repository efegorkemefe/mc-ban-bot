// ── Staff Roster — data model + shared helpers ────────────────────────────────
// The single source of truth for staff membership, discipline, activity quotas,
// LOA / suspension status, and promotion eligibility. State lives in
// data/roster.json (authoritative, high-frequency, atomic writes); the Google
// Sheet "Staff Roster" tab is only ever a one-way display mirror (see sheets.js).
//
// This module is intentionally dependency-light (fs/path/report + discord.js
// PermissionFlagsBits only) so the pure helpers — getStaffTier, isExempt,
// computeEligibility — can be unit-tested without a Discord/Sheets connection.
// It must NOT require ./tickets, ./index, ./embeds or ./sheets (avoids cycles).

const fs = require('fs');
const path = require('path');
const { PermissionFlagsBits } = require('discord.js');
const { startOfWeek } = require('./report');

// ── Tier vocabulary ───────────────────────────────────────────────────────────
// Tier 1 = Staff, 2 = Senior Staff, 3 = Super Staff / Admin. A member's tier is
// the highest tier role they hold (see getStaffTier).
const TIER_NAMES = { 0: 'Not staff', 1: 'Staff', 2: 'Senior Staff', 3: 'Super Staff' };
function tierName(n) {
  return TIER_NAMES[n] || 'Unknown';
}

// ── Config readers (parsed fresh from process.env on each call) ─────────────────
// Re-reading keeps the pure helpers trivially testable (a test sets process.env
// then calls the function) and lets a /activity-toggle or .env edit take effect
// without a restart. The volume is tiny, so the parse cost is irrelevant.
function ids(v) {
  return (v || '').split(',').map(s => s.trim()).filter(Boolean);
}

function intOr(v, dflt) {
  const n = parseInt(v ?? '', 10);
  return Number.isNaN(n) ? dflt : n;
}

// Role IDs per tier + the permanent-exemption role. Exemption is OPT-IN: it does
// NOT fall back to MEMBER_ROLE_ID (staff normally also hold the member role, so the
// old fallback exempted everyone and made the weekly quota meaningless).
function roleConfig() {
  return {
    staff:  ids(process.env.STAFF_ROLE_IDS),
    senior: ids(process.env.SENIOR_ROLE_IDS),
    super:  ids(process.env.SUPER_ROLE_IDS),
    exempt: process.env.STAFF_EXEMPT_ROLE_ID || '',
  };
}

// Weekly quota requirements. 0 = not tracked. A member passes the week only if
// every NON-ZERO quota is met (see meetsQuota).
function quotaConfig() {
  return {
    bans:        Math.max(0, intOr(process.env.WEEKLY_QUOTA_BANS, 0)),
    wars:        Math.max(0, intOr(process.env.WEEKLY_QUOTA_WARS, 0)),
    tickets:     Math.max(0, intOr(process.env.WEEKLY_QUOTA_TICKETS, 0)),
    warnsIssued: Math.max(0, intOr(process.env.WEEKLY_QUOTA_WARNS, 0)),
  };
}

// Promotion-eligibility thresholds (passive flag only — see computeEligibility).
function promoConfig() {
  return {
    minTenureDays: intOr(process.env.PROMO_MIN_TENURE_DAYS, 30),
    weeksRequired: intOr(process.env.PROMO_QUOTA_WEEKS_REQUIRED, 6),
    weeksWindow:   intOr(process.env.PROMO_QUOTA_WEEKS_WINDOW, 8),
    maxWarns:      intOr(process.env.PROMO_MAX_WARNS, 2),
    minLifetime:   intOr(process.env.PROMO_MIN_LIFETIME_ACTIONS, 0),
  };
}

// Disciplinary escalation thresholds (auto-alert to Super Staff at/above these).
function thresholds() {
  return {
    warn:   intOr(process.env.STAFF_WARN_THRESHOLD, 3),
    strike: intOr(process.env.STAFF_STRIKE_THRESHOLD, 2),
  };
}

// ── Tier resolution ─────────────────────────────────────────────────────────────
// roleTierFrom: strictly role-based highest tier (no permission fallback).
function roleTierFrom(member, cfg) {
  const has = id => !!member?.roles?.cache?.has?.(id);
  if (cfg.super.some(has)) return 3;
  if (cfg.senior.some(has)) return 2;
  if (cfg.staff.some(has)) return 1;
  return 0;
}

// getStaffTier — the ONE permission gate for every command (old + new). Returns
// 0 (not staff), 1, 2, or 3. Administrator counts as tier 3 so server admins are
// never locked out; otherwise the tier is the highest tier role the member holds.
// Manage-Server alone grants nothing.
function getStaffTier(member) {
  if (!member) return 0;
  if (member.permissions?.has?.(PermissionFlagsBits.Administrator)) return 3;
  return roleTierFrom(member, roleConfig());
}

// roleTier — strictly role-based tier (ignores the Administrator fallback). Used
// by the reconcile job to detect MANUAL promotions/demotions (assigning a role)
// without mis-ranking a staffer who merely happens to hold Administrator.
function roleTier(member) {
  if (!member) return 0;
  return roleTierFrom(member, roleConfig());
}

// canActOn — for any action targeting another staff member, the invoker's tier
// must be strictly greater than the target's (no acting on an equal/higher tier).
function canActOn(invokerTier, targetTier) {
  return invokerTier > targetTier;
}

// ── Exemption gate ──────────────────────────────────────────────────────────────
// isExempt — the SINGLE exemption gate. A member is exempt from quota tracking if
// they are on LOA, suspended, OR hold the permanent-exemption role. All quota
// logic calls this; nothing re-checks those conditions itself.
// Pure core: (entry, member). entry supplies LOA/suspension status; member
// supplies the exempt-role check. isExemptId() is the async convenience wrapper.
function isExempt(entry, member) {
  if (entry && (entry.status === 'loa' || entry.status === 'suspended')) return true;
  const exemptId = roleConfig().exempt;
  if (exemptId && member?.roles?.cache?.has?.(exemptId)) return true;
  return false;
}

// Convenience wrapper used by call sites that only have an id + guild. Delegates
// to the pure core after loading the entry and fetching the member.
async function isExemptId(userId, guild) {
  const entry = getEntry(userId);
  const member = guild ? await guild.members.fetch(userId).catch(() => null) : null;
  return isExempt(entry, member);
}

// ── Discipline / activity accessors (pure) ──────────────────────────────────────
function activeList(arr) {
  return (arr || []).filter(x => x && !x.pardoned);
}
function activeWarns(entry) {
  return activeList(entry?.warns).length;
}
function activeStrikes(entry) {
  return activeList(entry?.strikes).length;
}
function lifetimeActions(entry) {
  const lt = entry?.lifetime || {};
  return (lt.bans || 0) + (lt.wars || 0) + (lt.tickets || 0) + (lt.warnsIssued || 0);
}

// ── Tenure (LOA / suspension pause the clock) ───────────────────────────────────
// Effective tenure = wall time since tenureStart, minus accumulated paused time,
// minus any currently-running pause. tenureStart resets on a tier change.
function effectiveTenureMs(entry, now = Date.now()) {
  const start = Date.parse(entry?.tenureStart || entry?.staffJoinDate || '');
  if (Number.isNaN(start)) return 0;
  let paused = entry.tenurePausedMs || 0;
  if (entry.pauseStartedAt) {
    const ps = Date.parse(entry.pauseStartedAt);
    if (!Number.isNaN(ps)) paused += Math.max(0, now - ps);
  }
  return Math.max(0, now - start - paused);
}
function effectiveTenureDays(entry, now = Date.now()) {
  return Math.floor(effectiveTenureMs(entry, now) / 86_400_000);
}

// ── Weekly quota ────────────────────────────────────────────────────────────────
// meetsQuota — true iff every NON-ZERO weekly quota is met. With all quotas 0
// (the default), this is vacuously true so no one is ever auto-struck until the
// server configures real quotas.
function meetsQuota(counters, q = quotaConfig()) {
  const c = counters || {};
  if (q.bans > 0 && (c.bans || 0) < q.bans) return false;
  if (q.wars > 0 && (c.wars || 0) < q.wars) return false;
  if (q.tickets > 0 && (c.tickets || 0) < q.tickets) return false;
  if (q.warnsIssued > 0 && (c.warnsIssued || 0) < q.warnsIssued) return false;
  return true;
}

// ── Promotion eligibility (passive flag only) ───────────────────────────────────
// Pure over roster data (tier read from entry.tier). Surfaced on /roster,
// /roster-list and /eligible — never auto-pings. Super Staff promote manually.
function computeEligibility(entry, { now = Date.now() } = {}) {
  const p = promoConfig();

  const tenureDays = effectiveTenureDays(entry, now);
  const tenureOk = tenureDays >= p.minTenureDays;

  const window = (entry.history || []).slice(-p.weeksWindow);
  const weeksPassed = window.filter(w => w && w.passed).length;
  const quotaOk = weeksPassed >= p.weeksRequired;

  const aStrikes = activeStrikes(entry);
  const strikesOk = aStrikes === 0;

  const aWarns = activeWarns(entry);
  const warnsOk = aWarns < p.maxWarns;

  const lifetime = lifetimeActions(entry);
  const lifetimeOk = lifetime >= p.minLifetime;

  const statusOk = entry.status === 'active';

  const reasons = [];
  if (!statusOk) reasons.push(entry.status === 'loa' ? 'On LOA' : entry.status === 'suspended' ? 'Suspended' : 'Inactive');
  if (!tenureOk) reasons.push(`Tenure ${tenureDays}/${p.minTenureDays}d`);
  if (!quotaOk) reasons.push(`Quota weeks ${weeksPassed}/${p.weeksRequired}`);
  if (!strikesOk) reasons.push(`${aStrikes} active strike(s)`);
  if (!warnsOk) reasons.push(`Active warns ${aWarns} (must be < ${p.maxWarns})`);
  if (!lifetimeOk) reasons.push(`Lifetime actions ${lifetime}/${p.minLifetime}`);

  const eligible = statusOk && tenureOk && quotaOk && strikesOk && warnsOk && lifetimeOk;

  return {
    eligible,
    tenureDays, tenureOk,
    weeksPassed, weeksRequired: p.weeksRequired, weeksWindow: p.weeksWindow, quotaOk,
    activeStrikes: aStrikes, strikesOk,
    activeWarns: aWarns, warnsOk, maxWarns: p.maxWarns,
    lifetimeActions: lifetime, lifetimeOk,
    statusOk,
    reasons,
  };
}

// ── Persistence (data/roster.json + data/roster-archive.json) ────────────────────
// Atomic writes: serialize to a temp file then rename over the target, so a crash
// mid-write can never leave a half-written (corrupt) roster. mutate() does a
// synchronous load→change→save in a single tick, so concurrent async command
// handlers can never interleave a read-modify-write and clobber each other.
const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'roster.json');
const ARCHIVE_FILE = path.join(DATA_DIR, 'roster-archive.json');

function defaultStore() {
  return { activityEnabled: true, meta: { lastQuotaRun: null }, members: {} };
}

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    d.members = d.members || {};
    d.meta = d.meta || { lastQuotaRun: null };
    if (typeof d.activityEnabled !== 'boolean') d.activityEnabled = true;
    return d;
  } catch {
    return defaultStore();
  }
}

function writeAtomic(file, obj) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

function save(store) {
  writeAtomic(FILE, store);
}

// Read-modify-write helper. `fn` mutates the store in place and may return a value
// (e.g. the affected member) which mutate() returns to the caller after saving.
function mutate(fn) {
  const store = load();
  const result = fn(store);
  save(store);
  return result;
}

function loadArchive() {
  try {
    return JSON.parse(fs.readFileSync(ARCHIVE_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}
function saveArchive(archive) {
  writeAtomic(ARCHIVE_FILE, archive);
}

// ── Entry factory + read accessors ──────────────────────────────────────────────
function weekStartIso(now = Date.now()) {
  return startOfWeek(new Date(now)).toISOString().slice(0, 10);
}

function newWeek(now = Date.now()) {
  return { weekStart: weekStartIso(now), bans: 0, wars: 0, tickets: 0, warnsIssued: 0 };
}

function newEntry({ discordId, tier, onboardedBy = null, now = Date.now() }) {
  const iso = new Date(now).toISOString();
  return {
    discordId,
    tier,
    staffJoinDate: iso,
    tenureStart: iso,
    tenurePausedMs: 0,
    pauseStartedAt: null,
    onboardedBy,
    warns: [],
    strikes: [],
    lifetime: { bans: 0, wars: 0, tickets: 0, warnsIssued: 0 },
    currentWeek: newWeek(now),
    history: [],
    status: 'active',
    loa: null,
    suspension: null,
    priorTier: null,
  };
}

function getEntry(userId) {
  return load().members[userId] || null;
}

function allMembers() {
  return Object.values(load().members);
}

function isActivityEnabled() {
  return load().activityEnabled !== false;
}

function getMeta() {
  return load().meta || {};
}

function setActivityEnabled(enabled) {
  return mutate(store => { store.activityEnabled = !!enabled; return store.activityEnabled; });
}

function setLastQuotaRun(iso) {
  return mutate(store => { store.meta = store.meta || {}; store.meta.lastQuotaRun = iso; });
}

// ── Discipline (warns / strikes / pardons) ──────────────────────────────────────
function nextId(list) {
  return (list || []).reduce((max, x) => Math.max(max, x.id || 0), 0) + 1;
}

// Adds a warn or strike. kind ∈ { 'warn', 'strike' }. Returns
// { ok, entry, item, activeCount } or { ok:false } if the user isn't on the roster.
function addDiscipline(userId, kind, { reason = '', issuerId = null, auto = false, now = Date.now() } = {}) {
  return mutate(store => {
    const m = store.members[userId];
    if (!m) return { ok: false };
    const list = kind === 'strike' ? (m.strikes = m.strikes || []) : (m.warns = m.warns || []);
    const item = { id: nextId(list), reason, issuerId, timestamp: new Date(now).toISOString(), auto, pardoned: false };
    list.push(item);
    return { ok: true, entry: m, item, activeCount: list.filter(x => !x.pardoned).length };
  });
}
function addWarn(userId, opts) { return addDiscipline(userId, 'warn', opts); }
function addStrike(userId, opts) { return addDiscipline(userId, 'strike', opts); }

// Marks a specific warn/strike pardoned. type ∈ { 'warn', 'strike' }.
// Returns { ok, found, entry }.
function pardon(userId, type, id) {
  return mutate(store => {
    const m = store.members[userId];
    if (!m) return { ok: false, found: false };
    const list = type === 'strike' ? (m.strikes || []) : (m.warns || []);
    const item = list.find(x => x.id === id);
    if (!item) return { ok: true, found: false, entry: m };
    item.pardoned = true;
    return { ok: true, found: true, entry: m, item };
  });
}

// ── Lifecycle (onboard / offboard / edit / terminate) ───────────────────────────
// Onboard — the ONLY valid way to join the roster. Creates a fresh active entry.
function onboard(userId, { tier, onboardedBy = null, now = Date.now() }) {
  return mutate(store => {
    if (store.members[userId]) return { ok: false, reason: 'exists', entry: store.members[userId] };
    const entry = newEntry({ discordId: userId, tier, onboardedBy, now });
    store.members[userId] = entry;
    return { ok: true, entry };
  });
}

function getArchiveEntry(userId) {
  return loadArchive()[userId] || null;
}

// Removes from the active roster + writes a full archive snapshot. Archive is
// written BEFORE the removal so a crash between the two leaves a recoverable
// duplicate rather than a lost record. terminated=false → clean exit (offboard).
function archiveAndRemove(userId, { terminated, reason = '', actionedBy = null, now = Date.now() }) {
  const m = getEntry(userId);
  if (!m) return { ok: false };
  const archive = loadArchive();
  archive[userId] = { ...m, terminated: !!terminated, reason, actionedBy, timestamp: new Date(now).toISOString() };
  saveArchive(archive);
  mutate(store => { delete store.members[userId]; });
  return { ok: true, entry: m };
}
function offboard(userId, opts = {}) { return archiveAndRemove(userId, { ...opts, terminated: false }); }
function terminate(userId, opts = {}) { return archiveAndRemove(userId, { ...opts, terminated: true }); }

const EDITABLE_FIELDS = new Set(['tier', 'tenureStart', 'staffJoinDate', 'status']);

// Manual override for edge cases. Validates by field. A tier change resets tenure.
function editField(userId, field, rawValue, { now = Date.now() } = {}) {
  return mutate(store => {
    const m = store.members[userId];
    if (!m) return { ok: false, reason: 'not_found' };
    if (!EDITABLE_FIELDS.has(field)) return { ok: false, reason: 'bad_field' };
    let value = rawValue;
    if (field === 'tier') {
      const t = parseInt(rawValue, 10);
      if (![1, 2, 3].includes(t)) return { ok: false, reason: 'bad_value' };
      value = t;
      m.tenureStart = new Date(now).toISOString();
      m.tenurePausedMs = 0;
    } else if (field === 'tenureStart' || field === 'staffJoinDate') {
      const ms = Date.parse(rawValue);
      if (Number.isNaN(ms)) return { ok: false, reason: 'bad_value' };
      value = new Date(ms).toISOString();
    } else if (field === 'status') {
      if (!['active', 'loa', 'suspended'].includes(rawValue)) return { ok: false, reason: 'bad_value' };
    }
    m[field] = value;
    return { ok: true, entry: m, value };
  });
}

// ── Suspension (tenure clock pauses) ────────────────────────────────────────────
// Records priorTier + the EXACT roles held so reinstatement restores them precisely.
function suspend(userId, { reason = '', issuerId = null, durationMs = null, priorRoles = [], now = Date.now() }) {
  return mutate(store => {
    const m = store.members[userId];
    if (!m) return { ok: false };
    m.priorTier = m.tier;
    m.suspension = {
      reason,
      issuerId,
      start: new Date(now).toISOString(),
      end: durationMs ? new Date(now + durationMs).toISOString() : null,
      priorRoles: priorRoles.slice(),
      liftedAt: null,
    };
    m.status = 'suspended';
    if (!m.pauseStartedAt) m.pauseStartedAt = new Date(now).toISOString();
    return { ok: true, entry: m };
  });
}

// Ends a suspension (manual lift or auto-expiry). Resumes the tenure clock and
// returns the exact priorRoles + priorTier for the caller to restore in Discord.
function reinstate(userId, { now = Date.now() } = {}) {
  return mutate(store => {
    const m = store.members[userId];
    if (!m) return { ok: false };
    const susp = m.suspension || {};
    if (m.pauseStartedAt) {
      const ps = Date.parse(m.pauseStartedAt);
      if (!Number.isNaN(ps)) m.tenurePausedMs = (m.tenurePausedMs || 0) + Math.max(0, now - ps);
      m.pauseStartedAt = null;
    }
    m.status = 'active';
    if (m.suspension) m.suspension.liftedAt = new Date(now).toISOString();
    const priorRoles = (susp.priorRoles || []).slice();
    const priorTier = m.priorTier;
    m.priorTier = null;
    return { ok: true, entry: m, priorRoles, priorTier };
  });
}

// Suspensions whose end time has passed (for the hourly expiry cron).
function expiredSuspensions(now = Date.now()) {
  return allMembers().filter(m =>
    m.status === 'suspended' && m.suspension && m.suspension.end && Date.parse(m.suspension.end) <= now,
  );
}

// ── LOA ─────────────────────────────────────────────────────────────────────────
function loaRequest(userId, { reason = '', returnDate = null, requesterId = null, messageId = null, now = Date.now() }) {
  return mutate(store => {
    const m = store.members[userId];
    if (!m) return { ok: false };
    m.loa = {
      pending: true,
      reason,
      returnDate,
      requesterId: requesterId || userId,
      requestedAt: new Date(now).toISOString(),
      messageId: messageId || null,
      lastReminderAt: null,
      approvedBy: null,
      approvedAt: null,
    };
    return { ok: true, entry: m };
  });
}

function loaApprove(userId, { by = null, now = Date.now() } = {}) {
  return mutate(store => {
    const m = store.members[userId];
    if (!m || !m.loa) return { ok: false };
    m.loa.pending = false;
    m.loa.approvedBy = by;
    m.loa.approvedAt = new Date(now).toISOString();
    m.status = 'loa';
    if (!m.pauseStartedAt) m.pauseStartedAt = new Date(now).toISOString();
    return { ok: true, entry: m };
  });
}

function loaDeny(userId) {
  return mutate(store => {
    const m = store.members[userId];
    if (!m || !m.loa) return { ok: false };
    m.loa = null;
    return { ok: true, entry: m };
  });
}

function loaEnd(userId, { now = Date.now() } = {}) {
  return mutate(store => {
    const m = store.members[userId];
    if (!m) return { ok: false };
    const wasLoa = m.status === 'loa' || !!(m.loa && m.loa.pending);
    if (m.status === 'loa' && m.pauseStartedAt) {
      const ps = Date.parse(m.pauseStartedAt);
      if (!Number.isNaN(ps)) m.tenurePausedMs = (m.tenurePausedMs || 0) + Math.max(0, now - ps);
      m.pauseStartedAt = null;
    }
    if (m.status === 'loa') m.status = 'active';
    m.loa = null;
    return { ok: true, entry: m, wasLoa };
  });
}

// LOA requests still pending past `olderThanMs` (for the 48h reminder cron).
function pendingLoaRequests(olderThanMs = 0, now = Date.now()) {
  return allMembers().filter(m => {
    if (!m.loa || !m.loa.pending) return false;
    const at = Date.parse(m.loa.requestedAt || '');
    if (Number.isNaN(at)) return false;
    return now - at >= olderThanMs;
  });
}

function setLoaReminderAt(userId, ts) {
  return mutate(store => {
    const m = store.members[userId];
    if (m && m.loa) m.loa.lastReminderAt = ts;
  });
}

// ── Activity crediting + weekly roll ────────────────────────────────────────────
// Credits one unit of activity. ALWAYS tracks (even when the activity system is
// off — only auto-strikes are gated). No-op if the user isn't on the roster.
function creditActivity(userId, kind, n = 1) {
  if (!['bans', 'wars', 'tickets', 'warnsIssued'].includes(kind)) return false;
  return mutate(store => {
    const m = store.members[userId];
    if (!m) return false;
    if (!m.currentWeek) m.currentWeek = newWeek();
    if (!m.lifetime) m.lifetime = { bans: 0, wars: 0, tickets: 0, warnsIssued: 0 };
    m.currentWeek[kind] = (m.currentWeek[kind] || 0) + n;
    m.lifetime[kind] = (m.lifetime[kind] || 0) + n;
    return true;
  });
}

// Rolls a member's currentWeek into history with the given verdict and resets the
// counters for the new week. Used by the Monday quota cron (which decides passed/
// exempt with the Discord member in hand). Keeps the last 8 weeks.
function rollMemberWeek(userId, { passed, exempt, now = Date.now() }) {
  return mutate(store => {
    const m = store.members[userId];
    if (!m) return null;
    const cw = m.currentWeek || newWeek(now);
    m.history = m.history || [];
    m.history.push({
      weekStart: cw.weekStart,
      passed: !!passed,
      exempt: !!exempt,
      counters: { bans: cw.bans || 0, wars: cw.wars || 0, tickets: cw.tickets || 0, warnsIssued: cw.warnsIssued || 0 },
    });
    if (m.history.length > 8) m.history = m.history.slice(-8);
    m.currentWeek = newWeek(now);
    return cw;
  });
}

// ── Tier reconcile (detect MANUAL promotions/demotions) ─────────────────────────
// Updates a member's stored tier to match their current role-based tier. A real
// change resets the tenure clock (tenure is per-tier). Only active members are
// reconciled (suspended members have their roles intentionally stripped). Losing
// all staff roles (newTier < 1) is left for a manual /roster-offboard.
function reconcileTier(userId, newTier, now = Date.now()) {
  return mutate(store => {
    const m = store.members[userId];
    if (!m || m.status !== 'active') return null;
    if (newTier < 1) return null;
    if (m.tier === newTier) return { changed: false, from: m.tier, to: newTier };
    const from = m.tier;
    m.tier = newTier;
    m.tenureStart = new Date(now).toISOString();
    m.tenurePausedMs = 0;
    m.pauseStartedAt = null;
    return { changed: true, from, to: newTier };
  });
}

module.exports = {
  // tier vocabulary
  TIER_NAMES,
  tierName,
  // config readers
  roleConfig,
  quotaConfig,
  promoConfig,
  thresholds,
  // pure helpers
  getStaffTier,
  roleTier,
  canActOn,
  isExempt,
  isExemptId,
  activeWarns,
  activeStrikes,
  lifetimeActions,
  effectiveTenureMs,
  effectiveTenureDays,
  meetsQuota,
  computeEligibility,
  // state primitives
  load,
  save,
  mutate,
  loadArchive,
  saveArchive,
  newEntry,
  newWeek,
  weekStartIso,
  getEntry,
  allMembers,
  isActivityEnabled,
  getMeta,
  setActivityEnabled,
  setLastQuotaRun,
  // discipline
  addWarn,
  addStrike,
  pardon,
  // lifecycle
  onboard,
  offboard,
  terminate,
  editField,
  getArchiveEntry,
  // suspension
  suspend,
  reinstate,
  expiredSuspensions,
  // LOA
  loaRequest,
  loaApprove,
  loaDeny,
  loaEnd,
  pendingLoaRequests,
  setLoaReminderAt,
  // activity + reconcile
  creditActivity,
  rollMemberWeek,
  reconcileTier,
  FILE,
  ARCHIVE_FILE,
};
