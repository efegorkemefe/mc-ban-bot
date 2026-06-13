// ── Warnings store (data/warnings.json) ─────────────────────────────────────
// Formal warnings issued via /warn. Kept local (not the Google Sheet), keyed by
// Discord user ID. Powers /warnings and the WARN_BAN_THRESHOLD ban suggestion.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'warnings.json');

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    d.warnings = d.warnings || {};
    return d;
  } catch {
    return { warnings: {} };
  }
}

function save(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// Records a warning. `info` = { by, byTag, reason }. Returns { entry, count }.
function addWarning(userId, { by, byTag, reason } = {}) {
  const data = load();
  const list = data.warnings[userId] || (data.warnings[userId] = []);
  const entry = {
    id: (list.length ? list[list.length - 1].id : 0) + 1,
    by: by || null,
    byTag: byTag || '',
    reason: reason || '',
    at: new Date().toISOString(),
  };
  list.push(entry);
  save(data);
  return { entry, count: list.length };
}

function getWarnings(userId) {
  return load().warnings[userId] || [];
}

function countWarnings(userId) {
  return getWarnings(userId).length;
}

module.exports = { addWarning, getWarnings, countWarnings };
