// ── Aggregation helpers ───────────────────────────────────────────────────────
// Pure functions that crunch ban/war rows into the counts the /stats dashboard
// shows. Kept free of Discord/Sheets so they can be unit-tested directly.

const { computeBanEnd } = require('./duration');

// Summarizes a list of bans (each from sheets.rowToBan). `isUnbanned(banId)`
// tells us which bans have been lifted via /unban.
//   → { total, severity:{LOW..PERMANENT:n}, active, expired, lifted, topStaff:[[name,count]] }
function summarizeBans(bans, isUnbanned = () => false) {
  const severity = {};
  const staff = {};
  let active = 0;
  let expired = 0;
  let lifted = 0;

  for (const b of bans) {
    const sev = String(b.severity || '').toUpperCase();
    if (sev) severity[sev] = (severity[sev] || 0) + 1;
    if (b.staff_member) staff[b.staff_member] = (staff[b.staff_member] || 0) + 1;

    if (isUnbanned(b.ban_id)) lifted++;
    else if (computeBanEnd(b.date, b.duration).state === 'ended') expired++;
    else active++;
  }

  const topStaff = Object.entries(staff).sort((a, b) => b[1] - a[1]).slice(0, 5);
  return { total: bans.length, severity, active, expired, lifted, topStaff };
}

// Summarizes war/raid rows (each from sheets.rowToWar).
//   → { total, status:{APPROVED,DENIED,PENDING:n}, type:{war,raid:n} }
function summarizeWars(wars) {
  const status = {};
  const type = {};

  for (const w of wars) {
    const s = String(w.status || '').toUpperCase();
    const t = String(w.type || '').toLowerCase();
    if (s) status[s] = (status[s] || 0) + 1;
    if (t) type[t] = (type[t] || 0) + 1;
  }

  return { total: wars.length, status, type };
}

module.exports = { summarizeBans, summarizeWars };
