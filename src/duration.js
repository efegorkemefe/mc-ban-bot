// ── Ban duration parsing ──────────────────────────────────────────────────────
// Staff type ban durations as freeform text ("7d", "2 weeks", "Permanent").
// These helpers turn that into a concrete end date so the bot can show when a
// ban expires and tell active bans apart from expired ones.

const UNIT_MS = {
  s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
  m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
  h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
  d: 86_400_000, day: 86_400_000, days: 86_400_000,
  w: 604_800_000, wk: 604_800_000, wks: 604_800_000, week: 604_800_000, weeks: 604_800_000,
  mo: 2_592_000_000, mon: 2_592_000_000, month: 2_592_000_000, months: 2_592_000_000,
  y: 31_536_000_000, yr: 31_536_000_000, yrs: 31_536_000_000, year: 31_536_000_000, years: 31_536_000_000,
};

// True for durations that never end (so there is no expiry date to compute).
function isPermanent(str) {
  return /\b(perm|permanent|forever|never|indefinite|infinite)\b/i.test(String(str || '')) ||
    String(str || '').includes('∞');
}

// Parses a duration string into milliseconds, summing every "<number><unit>"
// token it finds (e.g. "1w 3d" → 10 days). Returns null when nothing parseable
// is present (including permanent durations, which have no finite length).
function parseDurationMs(str) {
  if (!str || isPermanent(str)) return null;
  const s = String(str).toLowerCase();
  const re = /(\d+(?:\.\d+)?)\s*([a-z]+)/g;
  let total = 0;
  let matched = false;
  let m;
  while ((m = re.exec(s)) !== null) {
    const unit = UNIT_MS[m[2]] || UNIT_MS[m[2].replace(/s$/, '')];
    if (unit) {
      total += parseFloat(m[1]) * unit;
      matched = true;
    }
  }
  return matched ? total : null;
}

// Works out when a ban ends from its logged date + duration. Returns one of:
//   { state: 'permanent' }            — never expires
//   { state: 'unknown' }              — duration/date couldn't be parsed
//   { state: 'active', endMs }        — expires in the future
//   { state: 'ended',  endMs }        — already expired
function computeBanEnd(dateStr, durationStr, now = Date.now()) {
  if (isPermanent(durationStr)) return { state: 'permanent' };

  const ms = parseDurationMs(durationStr);
  const start = Date.parse(dateStr);
  if (ms == null || Number.isNaN(start)) return { state: 'unknown' };

  const endMs = start + ms;
  return { state: endMs <= now ? 'ended' : 'active', endMs };
}

module.exports = { isPermanent, parseDurationMs, computeBanEnd };
