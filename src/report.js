// ── Staff activity aggregation ──────────────────────────────────────────────
// Pure functions powering the weekly staff report and the /leaderboard command.
// Kept free of Discord/Sheets so they can be unit-tested directly.

// Monday 00:00 (local time) of the week containing `d`.
function startOfWeek(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  const day = x.getDay();              // 0 Sun … 6 Sat
  const sinceMonday = day === 0 ? 6 : day - 1;
  x.setDate(x.getDate() - sinceMonday);
  return x;
}

function parseDateMs(s) {
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

// Counts items per name, optionally restricted to [sinceMs, untilMs).
function tallyByName(items, nameKey, dateKey, sinceMs = null, untilMs = null) {
  const out = {};
  for (const it of items) {
    const name = String((it && it[nameKey]) || '').trim();
    if (!name) continue;
    if (sinceMs != null || untilMs != null) {
      const ms = parseDateMs(it[dateKey]);
      if (ms == null) continue;
      if (sinceMs != null && ms < sinceMs) continue;
      if (untilMs != null && ms >= untilMs) continue;
    }
    out[name] = (out[name] || 0) + 1;
  }
  return out;
}

function sortDesc(obj) {
  return Object.entries(obj).sort((a, b) => b[1] - a[1]);
}

// Builds the weekly digest. `bans`/`wars` come from sheets.rowToBan/rowToWar;
// `closedTickets` from tickets.getClosedTickets (see src/tickets.js). The window
// is [weekStartMs, weekEndMs) — when weekEndMs is omitted it is open-ended.
function weeklyStaffReport({ bans = [], wars = [], closedTickets = [], weekStartMs, weekEndMs = null }) {
  const banCounts = sortDesc(tallyByName(bans, 'staff_member', 'date', weekStartMs, weekEndMs));
  const warCounts = sortDesc(tallyByName(wars, 'approved_by', 'date', weekStartMs, weekEndMs));

  const ticketCounts = {};
  let responseSum = 0;
  let responseN = 0;
  let ticketsClosed = 0;

  for (const t of closedTickets) {
    const ms = parseDateMs(t.closedAt);
    if (ms == null || ms < weekStartMs) continue;
    if (weekEndMs != null && ms >= weekEndMs) continue;
    ticketsClosed++;
    // Only human closers count toward the per-staff tally — bot auto-closures
    // (inactivity / whitelist auto-approve) carry no closedByName.
    if (t.closedByName) ticketCounts[t.closedByName] = (ticketCounts[t.closedByName] || 0) + 1;
    if (typeof t.firstResponseMs === 'number' && t.firstResponseMs >= 0) {
      responseSum += t.firstResponseMs;
      responseN++;
    }
  }

  return {
    banCounts,
    warCounts,
    ticketCounts: sortDesc(ticketCounts),
    ticketsClosed,
    avgFirstResponseMs: responseN ? Math.round(responseSum / responseN) : null,
  };
}

// Ban leaderboard by staff name, descending. `sinceMs` (optional) restricts to
// bans logged on/after that time (used for the "This Week" toggle).
function banLeaderboard(bans = [], { sinceMs = null } = {}) {
  return sortDesc(tallyByName(bans, 'staff_member', 'date', sinceMs));
}

module.exports = { startOfWeek, parseDateMs, tallyByName, weeklyStaffReport, banLeaderboard };
