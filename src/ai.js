// ── AI whitelist review ─────────────────────────────────────────────────────
// Uses Claude (Anthropic API) to evaluate a whitelist application and return a
// structured approve/reject verdict. The SDK + API key are loaded lazily so the
// rest of the bot keeps working even if the dependency or key is missing — in
// that case reviewWhitelist() returns { ok: false } and the caller falls back to
// manual staff review.

const MODEL = 'claude-opus-4-8';

let _client = null;
let _triedInit = false;

function getClient() {
  if (_client) return _client;
  if (_triedInit) return null;
  _triedInit = true;

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    console.warn('⚠️ ANTHROPIC_API_KEY not set — AI whitelist review disabled (manual review only).');
    return null;
  }
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    _client = new Anthropic({ apiKey: key });
    return _client;
  } catch (err) {
    console.error('⚠️ Could not load @anthropic-ai/sdk — AI review disabled:', err.message);
    return null;
  }
}

const SYSTEM_PROMPT = `You are the whitelist application reviewer for the "SovietCraft" Minecraft server. \
You decide whether to APPROVE or REJECT an applicant based on the text they submitted.

Approve when the application reasonably shows ALL of the following:
- A plausible Minecraft username (in-game name).
- A stated age (any age is acceptable as long as one is given and it is not obviously fake).
- Indicates they own an ORIGINAL / premium (paid) copy of Minecraft. If they clearly say they use a cracked/pirated/non-original copy, REJECT.
- A genuine, good-faith reason for wanting to join — more than a couple of low-effort words.

Reject when the application is low-effort, trolling, spam, gibberish, blank, self-contradictory, \
clearly not a real application, or explicitly states they do NOT own an original copy of Minecraft. \
Be reasonably lenient toward sincere newcomers who answer the questions, even briefly — but require an actual answer to each.

Respond with ONLY a single JSON object and NOTHING else, in exactly this shape:
{"decision":"approve"|"reject","confidence":"low"|"medium"|"high","summary":"one short sentence the applicant will read","reasons":["short bullet","short bullet"]}`;

// Pulls the first balanced JSON object out of the model's text response.
function extractJson(text) {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

// Returns { ok: true, decision, confidence, summary, reasons } on success,
// or { ok: false, error } if the AI is unavailable or the response was unusable.
async function reviewWhitelist(applicationText) {
  const client = getClient();
  if (!client) return { ok: false, error: 'AI review is not configured.' };

  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `Whitelist application to review:\n\n${applicationText}` }],
    });

    const text = (res.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n');

    const data = extractJson(text);
    if (!data || (data.decision !== 'approve' && data.decision !== 'reject')) {
      return { ok: false, error: 'AI returned an unparseable verdict.' };
    }

    return {
      ok: true,
      decision: data.decision,
      confidence: data.confidence || 'medium',
      summary: typeof data.summary === 'string' ? data.summary : '',
      reasons: Array.isArray(data.reasons) ? data.reasons.filter(r => typeof r === 'string') : [],
    };
  } catch (err) {
    console.error('AI whitelist review failed:', err);
    return { ok: false, error: err.message };
  }
}

// Whether AI review is configured (an API key is present).
function isEnabled() {
  return !!process.env.ANTHROPIC_API_KEY;
}

module.exports = { reviewWhitelist, isEnabled, extractJson };
