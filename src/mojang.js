// ── Mojang username verification ────────────────────────────────────────────
// Confirms a Minecraft in-game name actually exists by resolving it to a UUID
// via Mojang's public API. Used during whitelist review so fake/typo'd IGNs are
// caught before approval, and the UUID can be stored for cross-referencing.

const API = 'https://api.mojang.com/users/profiles/minecraft/';

// Minecraft usernames: 3–16 chars, letters/digits/underscore.
const IGN_RE = /^[A-Za-z0-9_]{3,16}$/;

// Words that look username-shaped but are almost never the IGN — used so prose
// in a free-text application ("yes", "original") isn't mistaken for the name
// when no explicit label is present.
const STOPWORDS = new Set([
  'yes', 'no', 'the', 'and', 'for', 'but', 'minecraft', 'original', 'java', 'bedrock',
  'premium', 'paid', 'copy', 'cracked', 'old', 'age', 'years', 'year', 'months', 'days',
  'want', 'wanna', 'join', 'joining', 'play', 'playing', 'because', 'please', 'hello',
  'server', 'username', 'name', 'ign', 'whitelist', 'application', 'apply', 'friends',
  'survival', 'world', 'really', 'love', 'town', 'nation', 'thanks', 'thank',
]);

// Pulls the most likely IGN out of a free-text whitelist application. Prefers an
// explicitly labelled value ("IGN: Steve", "username - Steve", "minecraft name: Steve")
// and otherwise falls back to the first username-shaped token that isn't a pure
// number or a common English word. Returns null when nothing plausible is found.
function extractIgn(text) {
  if (!text) return null;
  const labelled = /(?:ign|in[\s-]?game(?:\s*name)?|minecraft(?:\s*(?:user)?name)?|mc[\s-]*name|user\s*name|username)\s*(?:is|=|:|-)*\s*([A-Za-z0-9_]{3,16})/i.exec(text);
  if (labelled && !STOPWORDS.has(labelled[1].toLowerCase())) return labelled[1];

  for (const raw of String(text).split(/[\s,]+/)) {
    const tok = raw.replace(/^[^A-Za-z0-9_]+|[^A-Za-z0-9_]+$/g, ''); // trim surrounding punctuation
    if (!IGN_RE.test(tok)) continue;
    if (/^\d+$/.test(tok)) continue;            // pure number (age etc.)
    if (STOPWORDS.has(tok.toLowerCase())) continue;
    return tok;
  }
  return null;
}

// Formats Mojang's undashed 32-char UUID into the canonical dashed form.
function formatUuid(id) {
  const h = String(id || '').replace(/-/g, '');
  if (h.length !== 32) return String(id || '');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Verifies an IGN against Mojang. Returns:
//   { ok: true, uuid, name }       — the name resolves to a real profile
//   { ok: false, status: 404 }     — confirmed: no such username
//   { ok: false, status, error }   — API/network problem (do NOT treat as "doesn't exist")
async function verifyIgn(username, { timeoutMs = 8000 } = {}) {
  const name = String(username || '').trim();
  if (!IGN_RE.test(name)) return { ok: false, status: 400, error: 'Not a valid username format.' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(API + encodeURIComponent(name), { signal: controller.signal });
    // Mojang returns 404 (and historically 204) when the username doesn't exist.
    if (res.status === 404 || res.status === 204) return { ok: false, status: 404 };
    if (!res.ok) return { ok: false, status: res.status, error: `Mojang API returned HTTP ${res.status}.` };
    const data = await res.json().catch(() => null);
    if (!data || !data.id) return { ok: false, status: res.status, error: 'Unexpected Mojang response.' };
    return { ok: true, uuid: formatUuid(data.id), name: data.name || name };
  } catch (err) {
    if (err.name === 'AbortError') return { ok: false, status: 0, error: 'Mojang API timed out.' };
    return { ok: false, status: 0, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { extractIgn, verifyIgn, formatUuid, IGN_RE };
