# CLAUDE.md

Guidance for Claude Code when working in this repo. For human-facing docs see
[`README.md`](README.md) (setup + architecture) and [`USAGE.md`](USAGE.md)
(every command). This file is the fast orientation for making changes safely.

## What this is

`mc-ban-bot` — an all-in-one Discord bot for a Minecraft community (SovietCraft):
ban/war logging mirrored to Google Sheets, a category-based ticket system,
AI-assisted whitelist applications, a moderation toolkit, and a **Staff Roster**
system (three-tier permissions, discipline, LOA/suspension, weekly quotas).

## Commands

```bash
npm test         # node --test — runs all test/*.test.js. No token/sheet needed. Run this after any change.
npm start        # node src/index.js — starts the bot (needs .env + credentials.json).
npm run deploy   # node src/deploy-commands.js — registers slash commands with Discord.
node --check src/<file>.js   # quick syntax check without running the bot.
```

Re-run `npm run deploy` whenever a command/option is added, removed, or renamed.
With `GUILD_ID` set it registers to that guild instantly; blank ⇒ global (~1h to
propagate). This repo currently has no `GUILD_ID`, so deploy is **global**.

## Stack & conventions

- **CommonJS** (`require`/`module.exports`), Node ≥18, discord.js ^14, googleapis ^140,
  `@anthropic-ai/sdk`. Tests use the built-in `node --test` + `node:assert` — no Jest.
- **Thin handlers, pure helpers.** `src/index.js` routes interactions and does the
  Discord side-effects (roles/DMs/replies); the real logic + state live in leaf
  modules (`roster.js`, `tickets.js`, `sheets.js`, …) and the *pure, testable*
  helpers (`duration.js`, `report.js`, `stats.js`, and the helpers in `roster.js`).
  Put new business logic in a leaf module and unit-test it; keep `index.js` handlers
  thin. Embeds always come from `src/embeds.js`.
- **Embeds match the brand.** Build every embed in `embeds.js` reusing
  `brandAuthor`/`brandFooter`/`BRAND_COLOR` + `.setTimestamp()` so it sits visually
  beside the existing ones. Don't construct ad-hoc `EmbedBuilder`s in `index.js`.
- **Sheets writes go through the styling engine.** Reuse `THEME`, `cellFormat`,
  `formatRow`, `hexToColor`, `withRetry`, `getSheetId`, `range` in `sheets.js`. All
  Sheets calls are wrapped in `withRetry` (429/5xx backoff). `getSheetId` returns
  `undefined` for a missing tab — features degrade to off rather than crash.
- **State is per-module JSON in `data/`** (gitignored). Each module owns its file
  with `load()`/`save()`. `roster.js` adds **atomic** writes (temp file +
  `fs.renameSync`) and a synchronous `mutate(fn)` (load→change→save in one tick) to
  survive concurrent async handlers — prefer that pattern for new high-write state.
- **Scheduling = `setTimeout` + `setInterval` sweeps** in the `ClientReady` handler,
  all keyed off `report.startOfWeek()` (local Monday 00:00) and deduped via an
  ISO-Monday marker (e.g. `meta.lastQuotaRun`, `meta.lastWeeklyReport`). No cron lib.
- **Secrets** (`.env`, `credentials.json`) are gitignored — never commit them. When
  adding config, document it in **both** `.env` and `.env.example` with a comment.

## Module map (`src/`)

| File | Role |
|------|------|
| `index.js` | Entry point. Command + button routing, `/log-ban` evidence flow, all schedulers/crons, Discord side-effects. |
| `deploy-commands.js` | All `SlashCommandBuilder` definitions (registered by `npm run deploy`). |
| `embeds.js` | Every embed builder + the brand helpers. |
| `sheets.js` | Google Sheets reads/writes, cell styling/stamps, auto ban-ID, retry/backoff, Verified Players + Staff Roster mirror. |
| `tickets.js` | Ticket system: panel, categories, claim/close/priority, transcripts, inactivity sweep. `isStaff`/`isSenior` now delegate to `roster.getStaffTier`. |
| `roster.js` | **Staff Roster**: atomic state, the three-tier permission model, discipline, LOA/suspension, quota + promotion helpers. |
| `report.js` | Pure aggregation for `/leaderboard` + weekly staff report; owns `startOfWeek()`. |
| `stats.js` | Pure aggregation for `/stats`. |
| `warnings.js` / `notes.js` / `flags.js` | `/warn`, `/note`, alt-detection flag stores (JSON). |
| `banState.js` | Lifted/unban tracking (`data/bans.json`). |
| `duration.js` | Parses durations → expiry (pure, unit-tested). |
| `ai.js` | Claude-powered whitelist review (`claude-opus-4-8`). |
| `mojang.js` | IGN→UUID verification + IGN extraction. |

## Staff Roster system (the newest subsystem)

Authoritative store is `data/roster.json` (+ `data/roster-archive.json` for
offboarded/terminated records). The **"Staff Roster" Google Sheet tab is a one-way,
display-only mirror** — never read back as truth.

- **Permissions: one gate.** `roster.getStaffTier(member)` → `0|1|2|3` (Administrator
  ⇒ 3; else highest of `SUPER_ROLE_IDS`/`SENIOR_ROLE_IDS`/`STAFF_ROLE_IDS`;
  Manage-Server alone grants nothing). `index.js` gates every roster command via
  `requireTier(interaction, n)`; actions on another staffer also require
  `canActOn(invokerTier, targetTier)` (strictly higher). Route **all** new permission
  checks through `getStaffTier` — don't reintroduce ad-hoc role-ID checks.
- **Pure, unit-tested helpers** (`test/roster.test.js`): `getStaffTier`, `roleTier`
  (role-only, for promotion reconcile — ignores the Admin fallback), `isExempt`,
  `computeEligibility`, `meetsQuota`, `effectiveTenureDays`, `canActOn`.
- **Exemption is opt-in.** `isExempt` is true only for LOA/suspended members or those
  holding `STAFF_EXEMPT_ROLE_ID`. It does **NOT** fall back to `MEMBER_ROLE_ID` —
  staff hold the member role too, so that fallback exempted everyone and made the
  weekly quota meaningless. Keep exemption opt-in.
- **Lifecycle ops** mutate JSON only and *return data* for the handler to act on in
  Discord (grant/strip roles, DM, log). Suspension records the member's **exact**
  prior roles and restores them on reinstatement; tenure clock pauses during
  LOA/suspension. Onboard grants **all** role IDs configured for the tier; a tier
  with no configured roles (e.g. blank `SUPER_ROLE_IDS`) still creates the entry but
  grants no Discord role and says so. **Tier reconcile never auto-demotes a member
  off a tier whose role IDs are unconfigured** — otherwise a freshly-onboarded Super
  Staffer drops to Senior on the next sweep when `SUPER_ROLE_IDS` is blank.
- **Activity hooks** (`creditActivity`) fire in `finalizeBan`, `handleLogWar`,
  `handleWarn`, and human ticket-closes — always tracked, even when the activity
  system is toggled off (only the Monday auto-strike is gated by the toggle).
- **Mirror** (`sheets.writeRosterMirror`): full-snapshot rewrite (clear rows ≥
  `ROSTER_DATA_START_ROW`, rewrite, one batched formatting call). Columns
  `A Onboard·B Member·C Tier·D Status·E Weekly Quota·F Warns·G Strikes·H Promotion·I Tenure`.
  Stamp constants `TIER_CELL`/`ROSTER_STATUS_CELL`/`QUOTA_CELL`/`PROMO_CELL` are kept
  **separate** from `SEVERITY_CELL`/`STATUS_CELL` so restyling one tab never breaks
  the other. No-ops when `ROSTER_SHEET_NAME` is blank or the tab doesn't exist.
- **Mirror rendering matches the example rows** (must stay professional, no emojis):
  full tier names via `TIER_LABEL` (`Staff`/`Senior Staff`/`Super Staff`), plain
  `QUOTA_LABEL` (`Met`/`Missed`/`Exempt`/`N/A`), tenure as `"<n> Days"`
  (`tenureLabel`), promotion as a gold **"Eligible for Promotion"** stamp
  (`PROMO_CELL.eligible`, a colour used nowhere else on the tab) or muted
  "Not Eligible". Every cell gets subtle dividers (`rosterBorders`, written via
  `FMT_FIELDS_BORDERS` — kept off the shared `FMT_FIELDS` so ban/war tabs are never
  touched); stamps are Arial 10pt bold centered. **Quota column reflects what's
  configured:** with all `WEEKLY_QUOTA_*` = 0 it shows `N/A` (`untracked`), not a
  misleading `Met`; once quotas exist it's `Met`/`Missed` from `currentWeek`.

## Gotchas

- **Don't run tests/writes against the live sheet.** Writes start at row 7 and
  auto-detect the next empty row; the roster mirror *clears and rewrites* its tab.
  Use a scratch spreadsheet.
- **Sheet tab names must match `.env` exactly** or every write to that tab fails.
- The `data/` directory and `roster.json` are created on first write — don't commit
  them; don't assume they exist when reading.
- After editing handlers in `index.js`, `node --check` it (it can't be `require`d
  without starting the bot), and run `npm test`.
