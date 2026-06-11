# 🔨 SovietCraft Community Bot (`mc-ban-bot`)

An all-in-one Discord bot for a Minecraft community. Three systems in one:

1. **Moderation logging** — staff log player **bans** and **war/raid approvals**;
   each entry is written to a styled **Google Sheet** and posted as a clean embed.
2. **Ticket system** — a button **control panel** opens private, category-based
   support/report/application channels with staff **claiming**, `/add`/`/remove`,
   and saved **transcripts** on close.
3. **Whitelist applications** — applicants apply in a ticket; **AI** (Claude) can
   auto-approve and grant the member role, or — with no API key — applications go
   to staff for manual approval via `/wl-accept`.

Everything is **rebrandable** via `.env` (name, colour, icon), so it isn't tied to
one server. This README gets a new developer up to speed quickly — no deep Discord
or Google knowledge assumed.

---

## How it works (the 30-second version)

- Staff run a slash command in Discord (e.g. `/log-ban`).
- The bot collects the info, writes a row to the Google Sheet, and posts an embed.
- For bans, the bot also asks the staff member to upload **screenshot evidence**,
  which it auto-attaches and then logs.
- Ban IDs are assigned **automatically** (first real ban = `ID: 001`, then 002, …).
  Staff never type the ID.

Two Google Sheet tabs are used inside one spreadsheet:

| Tab | What it holds |
|-----|----------------|
| **Ban Logs** | Every ban (date, staff, player, offense, severity, duration, evidence, ID, appeal status) |
| **War & Raid Approvals** | Every war/raid request and its approval status |

---

## Slash commands

| Command | What it does |
|---------|--------------|
| `/log-ban` | Log a ban. You fill in player/offense/severity/etc., then upload evidence screenshots. ID is auto-assigned. |
| `/update-appeal` | Change the appeal status (`Appealable` / `Unappealable` / `N/A`) for a ban by its ID. |
| `/lookup-ban` | Find a ban by its ID, or all bans for a player username (paged). Shows when the ban ends. |
| `/banlist` | Compact list of bans. Defaults to **active only**; `scope: all` shows everything (paged). |
| `/unban` | Mark a ban as **lifted** and announce it in the ban log. Lifted bans show as such in lookups/banlist. |
| `/history` | A player's full ban **timeline** (newest first) with active/expired/lifted status. |
| `/stats` | Moderation dashboard: bans by severity, top staff, war/raid counts, open tickets. |
| `/log-war` | Log a war or raid approval. Posts immediately — no evidence step. |
| `/lookup-war` | Find war/raid records for a team or player (paged). |

### Ticket commands

| Command | Who | What it does |
|---------|-----|--------------|
| `/ticket-panel` | Admin (Manage Server) | Posts the ticket control panel in the current channel and auto-creates the six ticket categories. |
| `/add` | Staff | Add a user to the current ticket. |
| `/remove` | Staff | Remove a user from the current ticket (cannot remove the owner). |
| `/claim` | Staff | Claim the ticket — only you and senior staff can respond afterward. |
| `/unclaim` | Claimer / Senior | Release a claimed ticket so all staff can respond again. |
| `/rename` | Staff | Rename the ticket channel. |
| `/close` | Staff / Owner | Archive (save transcript) and delete the ticket. |
| `/wl-accept` | Staff | Manually approve a whitelist applicant and grant them the member role. |

### Utility commands

| Command | Who | What it does |
|---------|-----|--------------|
| `/findban` | Everyone | A banned player looks up **their own Ban ID** by username (to give staff when appealing). |
| `/help` | Everyone | Shows how to use the bot; lists staff commands for staff. |
| `/ping` | Everyone | Bot status — latency, uptime, and open-ticket count. |

### The `/log-ban` evidence flow

1. Run `/log-ban` and fill in the fields (severity, appeal status, etc. are dropdowns).
2. The bot replies (only you can see it) asking for screenshots.
3. Upload one or more images **in the same channel** within **2 minutes**.
4. Each upload message is **auto-deleted** so the channel stays clean.
5. Type `done` when finished — or just wait, and it auto-logs when the 2 minutes are up.
6. The bot writes the row + posts the embed to the ban log channel, pinging senior
   staff if the severity is **HIGH / CRITICAL / PERMANENT**.

> **Evidence is re-hosted, not linked.** Discord CDN links now expire after ~24h, so
> the bot downloads each screenshot and **re-uploads** it as a permanent attachment
> (optionally to a separate `EVIDENCE_ARCHIVE_CHANNEL_ID`). The sheet stores a
> permanent Discord **message link** rather than a short-lived CDN URL, so ban
> evidence never rots.

---

## The Google Sheet layout (important!)

Both tabs follow the same pattern:

- **Row 1** = title banner
- **Row 2** = column headers
- **Rows 3–5** = `[EXAMPLE]` rows (templates — the bot ignores these)
- **Row 6** = a divider (the "black line")
- **Row 7 onward** = real logged entries

So the bot writes **starting at row 7** on both tabs. The placeholder text
`START HERE FIRST` in those cells gets overwritten by the first real entries.

### Styling

The bot reproduces the sheet's own dark theme **1:1** when it writes a row:

- Rows alternate shade (banding) so it reads like a real table.
- The **Severity** cell (bans) and **Status** cell (war/raids) get a coloured
  "stamp" — e.g. `HIGH` is orange, `PERMANENT` is purple, `APPROVED` is green.
- Font, size, text colour, and alignment all match the example rows.

These colours/fonts are sampled directly from the example rows and live in
`src/sheets.js` (`THEME`, `SEVERITY_CELL`, `STATUS_CELL`). If you restyle the sheet,
update those constants to match.

### Column order

**Ban Logs:** `A Date · B Staff · C Player · D Offense · E Severity · F Duration · G Evidence · H Ban ID · I Appeal Status`

**War & Raid Approvals:** `A Date · B Type · C Requesting · D Target · E Reason · F Approved By · G Outcome/Notes · H Cooldown Ends · I War Duration · J Status`

---

## Project structure

```
mc-ban-bot/
├── src/
│   ├── index.js            # Bot entry point: routes slash commands + ticket buttons, evidence flow
│   ├── deploy-commands.js  # Registers the slash commands with Discord (run once)
│   ├── sheets.js           # All Google Sheets reads/writes + cell styling + auto-ID + retry/backoff
│   ├── tickets.js          # Ticket system: panel, categories, claim/close, transcripts, inactivity sweep
│   ├── ai.js               # Claude-powered whitelist application review
│   ├── embeds.js           # Builds the Discord embeds (ban, war, appeal, lookups, banlist, stats, tickets)
│   ├── duration.js         # Parses ban durations → computes expiry (pure, unit-tested)
│   ├── banState.js         # Tracks lifted/unbanned bans in data/bans.json
│   └── stats.js            # Pure aggregation for /stats (bans/wars summaries)
├── test/                   # node --test unit tests for the pure helpers (run with `npm test`)
├── data/                   # Runtime state (ticket counters/category IDs, unban records) — gitignored
├── credentials.json        # Google service-account key — NEVER commit (gitignored)
├── .env                    # Secrets — NEVER commit (gitignored)
├── .env.example            # Template showing which env vars are needed
├── .gitignore
├── package.json
└── README.md
```

---

## Setup from scratch

### 1. Discord bot
1. https://discord.com/developers/applications → **New Application**.
2. **Bot** tab → copy the **Bot Token** (→ `DISCORD_TOKEN`).
3. Enable **Message Content Intent** under *Privileged Gateway Intents*
   (needed to read uploaded evidence).
4. **OAuth2 → URL Generator**: scopes `bot` + `applications.commands`; permissions
   `Send Messages`, `Embed Links`, `Read Message History`, `Manage Messages`
   (Manage Messages lets the bot auto-delete evidence uploads), `Manage Channels`
   (required by the ticket system to create categories/channels), `Manage Roles`
   (to edit ticket permission overwrites for claiming and to grant the member role
   on whitelist approval), and `Mention Everyone` if you want senior-role pings to
   work. The bot's role must sit **above** the member role in the role list, or it
   can't assign it.
5. Invite the bot with the generated URL.
6. Copy the **Application ID** (→ `CLIENT_ID`).

### 2. Google Sheets API
1. https://console.cloud.google.com → create/select a project.
2. Enable the **Google Sheets API**.
3. **Service Accounts** → create one → **Keys → Add Key → JSON**. Save the file as
   `credentials.json` in the project root.
4. Open your spreadsheet, **Share** it with the service-account email
   (looks like `name@project.iam.gserviceaccount.com`) as **Editor**.
5. Make sure the tab names match `BAN_SHEET_NAME` and `WAR_SHEET_NAME` in `.env`
   (currently **Ban Logs** and **War & Raid Approvals**).

### 3. Environment variables
Copy `.env.example` → `.env` and fill it in:

```env
DISCORD_TOKEN=          # Bot token
CLIENT_ID=              # Application ID
GUILD_ID=               # Optional: register commands to one guild for instant updates (blank = global)

# ── Branding (optional — rebrand without touching code) ──
BRAND_NAME=SovietCraft  # Name shown across all embeds
BRAND_COLOR=#5865f2     # Accent colour for panel / info embeds (hex)
BRAND_ICON_URL=         # Optional icon for embed author/footer lines
BAN_LOG_CHANNEL_ID=     # Channel where ban embeds are posted
EVIDENCE_ARCHIVE_CHANNEL_ID=  # Optional: separate channel to re-host evidence (defaults to ban log)
WAR_LOG_CHANNEL_ID=     # Channel where war/raid embeds are posted
SENIOR_ROLE_IDS=        # Comma-separated role IDs to ping for HIGH/CRITICAL/PERMANENT bans + Staff Reports
SPREADSHEET_ID=         # From the sheet URL: docs.google.com/spreadsheets/d/<THIS>/edit
BAN_SHEET_NAME=Ban Logs
WAR_SHEET_NAME=War & Raid Approvals

# ── Ticket system ──
STAFF_ROLE_IDS=         # Roles that can run every ticket / whitelist command (blank = Manage Server)
TICKET_LOG_CHANNEL_ID=  # Channel where closed-ticket transcripts + summaries are posted
STAFF_APP_MIN_DAYS=7    # Membership age (days) required to open a Staff Application
TICKET_INACTIVITY_HOURS=0       # Auto-close tickets idle this many hours (0 = disabled)
TICKET_INACTIVITY_WARN_HOURS=0  # Warn at this many idle hours before auto-close (0 = no warning)

# ── Whitelist ──
MEMBER_ROLE_ID=         # Role granted on whitelist approval (AI auto-approve or /wl-accept)
ANTHROPIC_API_KEY=      # Claude API key for AI whitelist review (blank = manual review only)
```

> To copy channel/role IDs in Discord: **User Settings → Advanced → Developer Mode**,
> then right-click a channel/role → *Copy ID*.

Optional overrides: `BAN_DATA_START_ROW` / `WAR_DATA_START_ROW` (both default to `7`)
if you change the sheet's example/divider layout.

### 4. Install & run
```bash
npm install
npm run deploy   # registers slash commands (run once, and again whenever commands change)
npm start        # starts the bot
npm test         # runs the unit tests (node --test) — no token/sheet needed
```

> Re-run `npm run deploy` any time you add/remove/rename a command or its options.
> Set `GUILD_ID` in `.env` during development so commands register to your test
> server **instantly** (global registration can take up to ~1 hour to propagate).

---

## Gotchas for the next dev

- **Tab names must match exactly.** If `.env` says `Ban Logs` but the tab is `Bans`,
  every write fails. (This already bit us once.)
- **Don't test against the live sheet.** Writes start at row 7 and auto-detect the next
  empty row — running tests can overwrite real entries. Use a scratch copy.
- **Ban IDs are computed from existing rows.** `getNextBanId()` takes the highest ID in
  the real-data rows and adds 1. Example rows (3–5) are ignored on purpose.
- **Auto-delete needs the Manage Messages permission** in the channel. Without it,
  logging still works — the upload message just isn't removed.

### Ticket / whitelist troubleshooting

- **`/add`, `/claim`, `/unclaim`, `/wl-accept` say "I'm missing Manage Roles" or
  "couldn't assign the role":** the bot needs the **Manage Roles** permission, and its
  role must sit **above** the ticket/member roles. Creating tickets only needs Manage
  Channels, but editing permissions and granting the member role need Manage Roles.
- **A command replies "Discord is rate-limiting this channel":** you hit Discord's
  channel-edit limit (e.g. claim/unclaim/rename in quick succession). Wait a minute
  and retry — the command no longer hangs, it just tells you to try again.
- **`/wl-accept` doesn't show up:** run `npm run deploy` (commands only register when
  you run that), then restart.
- **Whitelist Submit just pings staff instead of auto-deciding:** that's expected when
  `ANTHROPIC_API_KEY` is blank — see [AI whitelist review](#-ai-whitelist-review).
- **The startup log prints ⚠️ warnings:** that report (channels, roles, permissions)
  tells you exactly what's missing — fix those first.

---

## 🎫 Ticket system

A **control-panel, category-based** ticket system. Members click a button on a
pinned panel; the bot opens a **private channel** for them inside that ticket
type's own category. Staff manage it with slash commands and buttons.

### The seven ticket types

| Type | Category | Notes |
|------|----------|-------|
| 📝 Whitelist Application | own category | — |
| 🎫 General Support | own category | — |
| ⚔️ War / Raid Request | own category | — |
| 🚩 Member Report | own category | — |
| ⚖️ Ban Appeal | own category | **Pings staff** when opened; a **🔍 Look Up Ban** button pulls the real ban record from the sheet into the ticket |
| 🛡️ Staff Report | own category | **Pings senior staff** when opened |
| 🪖 Staff Application | own category | **Blocked** unless the member has been in the server ≥ `STAFF_APP_MIN_DAYS` (default 7) |

### Setup (one command)

Run **`/ticket-panel`** in the channel where you want the panel. On first run the
bot **auto-creates the seven categories** (hidden from `@everyone`, visible to staff)
and posts the panel with one button per type. Re-running it just re-posts the panel;
existing categories are reused.

> The bot needs the **Manage Channels** permission to create categories/channels and
> edit ticket permissions. Make sure it's high enough in the role list.

### How a ticket flows

1. A member clicks a panel button → the bot creates `type-0001` in that category,
   visible only to the member + staff, and posts a professional opening embed
   (with a per-type checklist of what to provide) plus **Claim** / **Close** buttons.
   - **One ticket per user, server-wide:** if they already have any open ticket,
     they're pointed to it instead of opening a new one.
   - **Whitelist** is different — see [AI whitelist review](#-ai-whitelist-review) below.
2. **Claiming** (button or `/claim`) locks the ticket: regular staff can still read
   but can no longer send — only the **claimer** and **senior staff** can respond.
   The channel is also renamed with a `CLM-` prefix (e.g. `CLM-support-0001`) so
   claimed tickets are obvious at a glance. `/unclaim` reverses both.
3. **`/add` / `/remove`** grant or revoke access for extra users.
4. **Closing** (button or `/close [reason]`) saves a full **text transcript** plus a
   summary embed to `TICKET_LOG_CHANNEL_ID`, then deletes the channel after 5s.

> **Inactivity auto-close (opt-in).** Set `TICKET_INACTIVITY_HOURS` (and optionally
> `TICKET_INACTIVITY_WARN_HOURS`) to have the bot warn, then auto-close, tickets that
> go quiet. Idle time is measured from the last **human** message, so the bot's own
> warning doesn't reset the clock. Both default to `0` (disabled).

### How state is stored

Lightweight, no real database. Each ticket channel encodes its `type`/`owner`/`status`
in the **channel topic** (written once at creation), and permission overwrites are the
source of truth for who can see/speak. A small JSON file (`data/tickets.json`,
gitignored) holds the per-type **category IDs**, the per-type **counter**, and the
**claim state** (who claimed which ticket).

> **Why claim state lives in the file, not the topic:** Discord rate-limits channel
> name/topic edits to ~2 per 10 minutes. Storing claim state in the topic meant
> claim/unclaim hit that limit and hung. The JSON store has no such limit, and the
> `CLM-` rename is fire-and-forget so it can never block a command.

### 🤖 AI whitelist review

The **Whitelist Application** type is handled by Claude. The flow:

1. The applicant opens a whitelist ticket and types their answers (Minecraft
   username, age, whether they own an original copy of MC, why they want to join)
   directly in the channel.
2. They click **📨 Submit for Review**. The bot gathers their messages and sends
   them to Claude (`claude-opus-4-8`), which returns an approve/reject verdict.
3. **Approved →** the bot **automatically grants the member role** (`MEMBER_ROLE_ID`),
   posts the verdict, and auto-closes the ticket after ~10s.
4. **Rejected →** the bot posts the reasons and shows an **Appeal Decision** button.
   Appealing pings senior staff (or staff) so a human can review — and approve with
   `/wl-accept` if warranted.

Staff can always approve manually with **`/wl-accept <user>`**, which grants the
member role regardless of the AI's decision.

> **No API key?** AI review is optional. If `ANTHROPIC_API_KEY` is blank, clicking
> Submit simply pings staff for a manual review — nothing breaks. The Anthropic SDK
> (`@anthropic-ai/sdk`) is already in `package.json`; run `npm install` to pull it.

### Config

Roles/limits come from `.env` (see `.env.example`):

- `STAFF_ROLE_IDS` — roles that can run **every** ticket / whitelist command. If
  blank, anyone with **Manage Server** is treated as staff.
- `SENIOR_ROLE_IDS` — reused from the ban config; senior staff can speak in
  *claimed* tickets and are pinged for Staff Reports and whitelist appeals.
- `TICKET_LOG_CHANNEL_ID` — where transcripts + close summaries are posted.
- `STAFF_APP_MIN_DAYS` — membership age required to open a Staff Application.
- `MEMBER_ROLE_ID` — role granted on whitelist approval (AI or `/wl-accept`).
- `ANTHROPIC_API_KEY` — enables AI whitelist review; blank = manual review only.

### Where the code lives

- Ticket type definitions, panel, claim/close logic, transcripts → `src/tickets.js`.
- Ticket embeds → `src/embeds.js` (`buildPanelEmbed`, `buildTicketOpenEmbed`, …).
- Slash command defs → `src/deploy-commands.js`.
- Button + command routing → `src/index.js`.

To add a ticket type, add an entry to `TICKET_TYPES` and `TYPE_ORDER` in
`src/tickets.js` — the panel, categories, and routing pick it up automatically.

---

## ⚠️ Security

`.env` and `credentials.json` hold real secrets (bot token + Google key) and are in
`.gitignore`. **Never commit them.** If either leaks, rotate the Discord token and
regenerate the Google service-account key immediately.
