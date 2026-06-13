// ── Staff notes store (data/notes.json) ─────────────────────────────────────
// Private staff notes attached to a Minecraft player username (NOT posted to the
// Google Sheet). Surfaced automatically inside /lookup-ban, /history and /notes.
// Keyed by the lowercased username so lookups are case-insensitive.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'notes.json');

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    d.notes = d.notes || {};
    return d;
  } catch {
    return { notes: {} };
  }
}

function save(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function keyFor(player) {
  return String(player || '').trim().toLowerCase();
}

// Adds a note. `info` = { by, byTag, text }. Returns the stored entry.
function addNote(player, { by, byTag, text } = {}) {
  const data = load();
  const k = keyFor(player);
  const list = data.notes[k] || (data.notes[k] = []);
  const entry = {
    id: (list.length ? list[list.length - 1].id : 0) + 1,
    player: String(player || '').trim(),
    by: by || null,
    byTag: byTag || '',
    text: String(text || ''),
    at: new Date().toISOString(),
  };
  list.push(entry);
  save(data);
  return entry;
}

// All notes for a player, newest first.
function getNotes(player) {
  return (load().notes[keyFor(player)] || []).slice().reverse();
}

module.exports = { addNote, getNotes };
