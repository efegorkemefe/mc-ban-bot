// ── Alt-detection flag store (data/flags.json) ──────────────────────────────
// Records suspicious-account flags (new-account age, ban-rejoin timing, or any
// future type) and the whitelist applicant log used to detect those patterns.
// Each flag carries: numeric id, Discord user ID, IGN, type, reason, timestamp,
// and resolved status. Surfaced via /flags and automatically inside /lookup-ban,
// /history and /notes when a flagged user's IGN appears.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'flags.json');

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    d.flags = d.flags || [];
    d.applicants = d.applicants || [];
    d.nextId = d.nextId || (d.flags.reduce((m, f) => Math.max(m, f.id || 0), 0) + 1);
    return d;
  } catch {
    return { flags: [], applicants: [], nextId: 1 };
  }
}

function save(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// Creates a flag. `info` = { discordId, ign, type, reason }. Returns the flag.
function addFlag({ discordId, ign, type, reason } = {}) {
  const data = load();
  const flag = {
    id: data.nextId++,
    discordId: discordId || null,
    ign: ign || '',
    type: type || 'flag',
    reason: reason || '',
    at: new Date().toISOString(),
    resolved: false,
    resolvedBy: null,
    resolvedAt: null,
    resolvedNote: '',
  };
  data.flags.push(flag);
  save(data);
  return flag;
}

function getUnresolvedFlags() {
  return load().flags.filter(f => !f.resolved);
}

function getUnresolvedFlagsByIgn(ign) {
  const t = String(ign || '').trim().toLowerCase();
  if (!t) return [];
  return load().flags.filter(f => !f.resolved && String(f.ign || '').trim().toLowerCase() === t);
}

// Marks a flag resolved. Returns { flag } on success, { already, flag } if it was
// already resolved, or null when no flag with that id exists.
function resolveFlag(id, { by, note } = {}) {
  const data = load();
  const flag = data.flags.find(f => f.id === Number(id));
  if (!flag) return null;
  if (flag.resolved) return { already: true, flag };
  flag.resolved = true;
  flag.resolvedBy = by || null;
  flag.resolvedAt = new Date().toISOString();
  flag.resolvedNote = note || '';
  save(data);
  return { flag };
}

// Fills the IGN onto any of a user's existing flags that were created before the
// IGN was known (e.g. account-age flags raised the moment the ticket opened).
function backfillIgn(discordId, ign) {
  if (!discordId || !ign) return;
  const data = load();
  let changed = false;
  for (const f of data.flags) {
    if (f.discordId === discordId && !f.ign) { f.ign = ign; changed = true; }
  }
  if (changed) save(data);
}

// Logs a whitelist applicant for join-timing pattern detection.
function recordApplicant({ discordId, ign, uuid, accountCreatedAt, ticketOpenedAt } = {}) {
  const data = load();
  data.applicants.push({
    discordId: discordId || null,
    ign: ign || '',
    uuid: uuid || '',
    accountCreatedAt: accountCreatedAt || null,
    ticketOpenedAt: ticketOpenedAt || new Date().toISOString(),
  });
  save(data);
}

// Backfills IGN/UUID onto the applicant's most recent record once verified.
function updateApplicantIgn(discordId, ign, uuid) {
  if (!discordId || !ign) return;
  const data = load();
  let changed = false;
  for (let i = data.applicants.length - 1; i >= 0; i--) {
    const a = data.applicants[i];
    if (a.discordId === discordId && !a.ign) {
      a.ign = ign;
      if (uuid) a.uuid = uuid;
      changed = true;
      break; // only the latest unfilled record
    }
  }
  if (changed) save(data);
}

// The most recent known IGN for a Discord user (from the applicant log), or null.
function getApplicantIgn(discordId) {
  if (!discordId) return null;
  const data = load();
  for (let i = data.applicants.length - 1; i >= 0; i--) {
    if (data.applicants[i].discordId === discordId && data.applicants[i].ign) {
      return data.applicants[i].ign;
    }
  }
  return null;
}

module.exports = {
  addFlag,
  getUnresolvedFlags,
  getUnresolvedFlagsByIgn,
  resolveFlag,
  backfillIgn,
  recordApplicant,
  updateApplicantIgn,
  getApplicantIgn,
};
