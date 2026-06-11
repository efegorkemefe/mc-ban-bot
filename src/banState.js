// ── Ban state (lifted / unbanned tracking) ──────────────────────────────────────
// The Google Sheet is the permanent ban record, but it has no "active vs lifted"
// column and we don't want to disturb its hand-tuned layout. Instead, unban
// actions are tracked locally in data/bans.json, keyed by normalized ban ID.
// This powers the "Lifted" indicator in lookups and the /banlist active filter.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'bans.json');

function normalizeId(id) {
  return String(id ?? '').replace(/^\s*id:\s*/i, '').trim();
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return { unbans: {} };
  }
}

function save(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// Returns the unban record ({ at, by, reason }) for a ban, or null if active.
function getUnban(banId) {
  return load().unbans[normalizeId(banId)] || null;
}

function isUnbanned(banId) {
  return !!getUnban(banId);
}

// Records (or overwrites) an unban. `info` = { at, by, reason }.
function setUnban(banId, info) {
  const data = load();
  data.unbans[normalizeId(banId)] = info;
  save(data);
}

function removeUnban(banId) {
  const data = load();
  delete data.unbans[normalizeId(banId)];
  save(data);
}

module.exports = { getUnban, isUnbanned, setUnban, removeUnban };
