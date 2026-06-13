# 📘 mc-ban-bot — Usage Manual

A complete, practical guide to operating the bot day to day. For installation and
architecture, see [`README.md`](README.md); this manual focuses on **how to use
every command and feature**.

- [Quick start](#quick-start)
- [Roles & permissions](#roles--permissions)
- [Command reference](#command-reference)
  - [Ban & war logging](#ban--war-logging)
  - [Lookups & analytics](#lookups--analytics)
  - [Tickets](#tickets)
  - [Moderation](#moderation)
  - [Notes & flags](#notes--flags)
  - [Panels & help](#panels--help)
- [Workflows](#workflows)
- [Automated features](#automated-features)
- [Configuration reference](#configuration-reference)
- [Data files](#data-files)
- [Troubleshooting](#troubleshooting)

---

## Quick start

```bash
npm install
npm run deploy   # register slash commands (re-run whenever commands change)
npm start        # start the bot
npm test         # run the unit tests (no token/sheet needed)
```

Set `GUILD_ID` in `.env` during development so commands register to your test
server **instantly** (global registration can take up to ~1 hour).

The first time the bot needs them it will **auto-create** the ticket categories
and the **Verified Players** sheet tab — no manual setup required.

---

## Roles & permissions

**Who can run staff commands?** Anyone whose role is listed in `STAFF_ROLE_IDS`,
or — if that's blank — anyone with the **Manage Server** permission. A second tier,
`SENIOR_ROLE_IDS`, can speak in *claimed* tickets, is pinged for escalations
(Staff Reports, Urgent tickets, HIGH/CRITICAL/PERMANENT bans), and can force-release
another staffer's claim.

**Permissions the bot itself needs** (give its role these, and drag it **above** the
member/ticket roles):

| Permission | Used for |
|------------|----------|
| Manage Channels | Creating/renaming/deleting ticket channels |
| Manage Roles | Locking claimed tickets, granting the member/verified role |
| Manage Nicknames | Setting an approved member's nickname to their IGN |
| Moderate Members | `/mute` (timeouts) |
| Manage Messages | Auto-deleting evidence uploads to keep channels clean |

On boot the console prints a configuration report and warns about any missing
permission.

---

## Command reference

> Most replies are **ephemeral** (only you see them). Logging commands post a public
> embed to the configured channel.

### Ban & war logging

| Command | Who | Notes |
|---------|-----|-------|
| `/log-ban player_banned offense severity duration appeal_status [date]` | Staff | Records the ban (ID auto-assigned), then you upload evidence — see the [evidence flow](#logging-a-ban-with-evidence). A **prior-history warning** appears first if the player already has bans. |
| `/log-war type requesting_team target_team reason status [...]` | Staff | Logs a war/raid approval and posts it immediately (no evidence step). |
| `/update-appeal ban_id status` | Staff | Set a ban's appeal status to **Appealable / Unappealable / N/A**. |
| `/unban ban_id [reason]` | Staff | Marks a ban **lifted** and announces it in the ban log. Lifted bans are flagged as such everywhere. |

**Severity** drives colour and the senior-staff ping: `LOW`, `MEDIUM`, `HIGH`,
`CRITICAL`, `PERMANENT`. **Duration** is free text — `7d`, `2 weeks`, `Permanent`,
`30m`, `1w 3d` — and is parsed to compute expiry.

### Lookups & analytics

| Command | Who | Notes |
|---------|-----|-------|
| `/lookup-ban query` | Staff | `query` is a Ban ID **or** a player username (paged). Shows expiry; surfaces notes/flags. |
| `/banlist [scope]` | Staff | `active` (default) or `all`, paged. |
| `/history player` | Staff | A player's full ban timeline; surfaces notes/flags. |
| `/stats` | Staff | Dashboard: bans by severity, top staff, war/raid counts, open tickets. |
| `/leaderboard` | Staff | Staff ranked by bans logged, with a **This Week / All Time** toggle button. |
| `/lookup-war team` | Staff | War/raid records for a team or player (paged). |
| `/findban username` | **Everyone** | A player privately looks up **their own** Ban ID(s) to give staff when appealing. |

### Tickets

Run these **inside a ticket channel** unless noted.

| Command | Who | Notes |
|---------|-----|-------|
| `/ticket-panel` | Admin | Posts the button panel and creates the seven categories. |
| `/claim` / `/unclaim` | Staff | Lock a ticket to you + senior staff / release it. |
| `/add user` / `/remove user` | Staff | Control who can see the ticket (can't remove the owner). |
| `/priority level` | Staff | Set **Low / Normal / Urgent** — see [priority](#setting-ticket-priority). |
| `/rename name` | Staff | Rename the channel. |
| `/close [reason]` | Staff / Owner | Save a transcript, then delete the channel. |
| `/wl-accept user` | Staff | Approve a whitelist applicant: grants the member (+ verified) role and sets their nickname to a verified IGN if known. |

### Moderation

| Command | Who | Notes |
|---------|-----|-------|
| `/mute user duration [reason]` | Staff | Silent Discord **timeout** (`10m`, `2h`, `1d`; max **28 days**). No logging, no embed — just an ephemeral confirmation. |
| `/warn user [reason]` | Staff | Formal warning stored locally; **DMs the user**. At `WARN_BAN_THRESHOLD` warnings (default 3) it suggests a ban (ephemeral hint — never auto-bans). |
| `/warnings user` | Staff | View a user's warning history. |

### Notes & flags

| Command | Who | Notes |
|---------|-----|-------|
| `/note player text` | Staff | Private staff note attached to a **Minecraft username** (never written to the sheet). |
| `/notes player` | Staff | List a player's notes (newest first) + surface any unresolved flags. |
| `/flags` | Staff | Review unresolved alt-detection flags (paged). |
| `/resolve-flag flag_id [note]` | Staff | Mark a flag handled, with an optional note. |

Notes and unresolved flags for a player are **also shown automatically** whenever
their IGN appears in `/lookup-ban`, `/history`, or `/notes`.

### Panels & help

| Command | Who | Notes |
|---------|-----|-------|
| `/help` | Everyone | Shows the player help board privately. |
| `/info-panel` | Admin | Posts the player Help & Info board in the channel (pin it in `#info`). |
| `/staff-panel` | Admin | Posts the staff handbook in the channel (pin it in your staff channel). |
| `/ping` | Everyone | Latency, uptime, open-ticket count. |

---

## Workflows

### Logging a ban (with evidence)

1. Run `/log-ban` and fill the fields (severity & appeal status are dropdowns; date
   defaults to today). If the player already has bans, an amber **prior-history**
   warning shows the count and most recent offense — review before continuing.
2. The bot replies privately and asks you to **upload screenshot(s)** in the channel
   within **2 minutes**. Each upload is auto-deleted to keep the channel tidy.
3. Type `done` to finish immediately, or just wait — it finalizes automatically when
   the window closes.
4. The ban is written to the sheet with an **auto-assigned ID**, the evidence is
   re-hosted so its link never expires, and the embed is posted to the ban-log
   channel. `HIGH` / `CRITICAL` / `PERMANENT` bans ping senior staff.

### Handling a ticket

1. **Claim** it (`/claim` or the **Claim** button) so other staff know it's yours —
   regular staff can still read but only you and seniors can reply.
2. Optionally set **priority** with `/priority` and pull in another staffer with
   `/add`.
3. Resolve the request, then `/close [reason]` — a transcript is archived to the
   ticket-log channel and the channel is deleted after a few seconds.
4. Can't continue? `/unclaim` so someone else can take over.

### Setting ticket priority

`/priority level` sets **Low**, **Normal**, or **Urgent**:

- The channel is renamed with a prefix — `low-`, none for Normal, or `URG-` —
  combined with the claim prefix (e.g. `CLM-URG-ban-appeal-0012`).
- The opening embed's **Priority** field updates.
- **Urgent** pings `SENIOR_ROLE_IDS` (unless a senior already claimed it).

### Whitelist application & verification

1. The applicant opens a **📝 Whitelist Application** ticket and answers the prompts
   (IGN, age, original copy, why they want to join).
2. They press **📨 Submit for Review**. The bot **verifies the IGN against Mojang**:
   - **Unknown username (404):** the submission is rejected with a "fix the spelling
     and resubmit" message.
   - **Valid:** the IGN + UUID are saved to the **Verified Players** sheet tab.
   - **Mojang outage:** verification is skipped (the applicant is never blocked by an
     API problem) and review continues.
3. With an `ANTHROPIC_API_KEY` set, **Claude** reviews the application and may approve
   instantly; otherwise it routes to staff. Approval grants the member role (and the
   verified role) and **sets the member's nickname to their IGN**.
4. If not approved, the applicant can press **Appeal Decision** to escalate to staff,
   who can approve with `/wl-accept`.

### Ban appeals

When a member opens a **⚖️ Ban Appeal**, have them type their Ban ID and press
**🔍 Look Up Ban** so their record appears in the channel. Review the offense,
severity, and evidence, then either `/unban` or explain the decision. Appeals that
sit unclaimed are [reminded automatically](#automated-features).

### Warnings, notes & flags

- Use `/warn` for formal, user-visible warnings (they get a DM). Use `/note` for
  **internal** context that the player never sees.
- When the alt-detection system raises a flag, it pings staff in the ticket. Review
  with `/flags` and clear it with `/resolve-flag <id>` once handled.

---

## Automated features

These run on their own once configured:

| Feature | Trigger | What happens |
|---------|---------|--------------|
| **Prior-ban alert** | `/log-ban` | Shows the staffer a warning if the player has previous bans. |
| **Minecraft verification** | Whitelist submit | Validates the IGN against Mojang; stores IGN/UUID; sets nickname on approval. |
| **New-account flag** | Whitelist ticket opens | Flags + pings staff if the Discord account is younger than `MIN_ACCOUNT_AGE_DAYS`. |
| **Ban-rejoin flag** | Whitelist ticket opens | Flags + pings staff if a ban ended/was lifted within `REJOIN_WINDOW_DAYS`. |
| **Appeal reminders** | Every 12h | Re-pings staff in the ban-log channel for open, **unclaimed** ban appeals older than `APPEAL_REMINDER_HOURS`. Claiming stops it. |
| **Weekly staff report** | Monday ~09:00 server time | Posts a digest to the ban-log channel: bans/wars/tickets-closed per staff + average first-response time. |
| **Inactivity auto-close** | Configurable | Warns then auto-closes idle tickets (`TICKET_INACTIVITY_*`). Off by default. |

---

## Configuration reference

All settings live in `.env` (copy from `.env.example`). IDs are copied from Discord
with **Developer Mode** on (right-click → *Copy ID*).

| Variable | Default | Purpose |
|----------|---------|---------|
| `DISCORD_TOKEN` | — | Bot token. |
| `CLIENT_ID` | — | Application ID (for command registration). |
| `GUILD_ID` | _(blank)_ | Register commands to one guild (instant) vs globally. |
| `BRAND_NAME` / `BRAND_COLOR` / `BRAND_ICON_URL` | SovietCraft / blurple / — | Rebranding for embeds. |
| `BAN_LOG_CHANNEL_ID` | — | Where ban embeds, unbans, reminders, and the weekly report post. |
| `EVIDENCE_ARCHIVE_CHANNEL_ID` | ban log | Optional separate channel to re-host evidence. |
| `WAR_LOG_CHANNEL_ID` | — | Where war/raid embeds post. |
| `SENIOR_ROLE_IDS` | _(blank)_ | Roles pinged for HIGH/CRITICAL/PERMANENT bans, Staff Reports, Urgent tickets. |
| `STAFF_ROLE_IDS` | _(blank)_ | Roles that can run staff commands (blank ⇒ Manage Server). |
| `TICKET_LOG_CHANNEL_ID` | — | Where closed-ticket transcripts are archived. |
| `STAFF_APP_MIN_DAYS` | `7` | Membership age required to open a Staff Application. |
| `TICKET_INACTIVITY_HOURS` / `_WARN_HOURS` | `0` | Auto-close / warn thresholds (0 = disabled). |
| `SPREADSHEET_ID` | — | The Google spreadsheet ID. |
| `BAN_SHEET_NAME` / `WAR_SHEET_NAME` | Ban Logs / War & Raid Approvals | Tab names. |
| `VERIFIED_SHEET_NAME` | Verified Players | Tab for verified IGN↔UUID (auto-created). |
| `MEMBER_ROLE_ID` | — | Role granted on whitelist approval. |
| `VERIFIED_ROLE_ID` | = member role | Extra "verified" role granted on approval. |
| `ANTHROPIC_API_KEY` | _(blank)_ | Enables AI whitelist review (blank ⇒ manual). |
| `WARN_BAN_THRESHOLD` | `3` | Warnings at/above this make `/warn` suggest a ban. |
| `APPEAL_REMINDER_HOURS` | `48` | Age before an unclaimed appeal is re-pinged (0 = off). |
| `MIN_ACCOUNT_AGE_DAYS` | `30` | New-account flag threshold. |
| `REJOIN_WINDOW_DAYS` | `14` | Ban-rejoin flag window. |

---

## Data files

Everything in `data/` is runtime state and **gitignored**. It's safe to back up but
should not be committed.

| File | Holds |
|------|-------|
| `data/tickets.json` | Per-guild category IDs, ticket counters, claim & priority state, closed-ticket stats, scheduler bookkeeping. |
| `data/bans.json` | Lifted/unbanned records (the sheet stays the permanent ban log). |
| `data/warnings.json` | `/warn` history, keyed by Discord user ID. |
| `data/notes.json` | Staff notes, keyed by player username. |
| `data/flags.json` | Alt-detection flags + the whitelist applicant log. |

The permanent record of bans, wars, and verified players lives in the **Google
Sheet**, not on disk.

---

## Troubleshooting

- **"I'm missing Manage Roles / Moderate Members":** grant the permission and drag the
  bot's role **above** the roles it manages.
- **A command doesn't appear:** run `npm run deploy`. Commands only register when you
  deploy, and global registration can take up to ~1 hour (use `GUILD_ID` for instant
  updates while testing).
- **Whitelist keeps rejecting a real IGN:** confirm the spelling is exact — the bot
  checks the literal name against Mojang. Mixed-case is fine; spaces/typos are not.
- **Nickname wasn't set on approval:** the bot can't rename the **server owner** and
  needs **Manage Nicknames** with its role above the member's — it logs a warning and
  continues either way.
- **Weekly report didn't post:** it posts once on/after **Monday 09:00 server time**;
  check `BAN_LOG_CHANNEL_ID` is reachable.
- **`/mute` failed:** the target may outrank the bot, or be an admin/owner (who can't
  be timed out). Timeouts are also capped at 28 days.
