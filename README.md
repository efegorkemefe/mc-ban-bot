# 🔨 SovietCraft Staff Bot (`mc-ban-bot`)

A Discord bot for the **SovietCraft** Minecraft server. Staff use slash commands to
log player **bans** and **war/raid approvals**. Every entry is:

1. Written into a **Google Sheet** (styled to match the sheet's dark theme), and
2. Posted as a clean **embed** in the right Discord staff channel.

This README is meant to get a new developer up to speed quickly. No deep Discord or
Google knowledge assumed.

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
| `/lookup-ban` | Find a ban by its ID, or all recent bans for a player username. |
| `/log-war` | Log a war or raid approval. Posts immediately — no evidence step. |
| `/lookup-war` | Find war/raid records for a team or player. |

### The `/log-ban` evidence flow

1. Run `/log-ban` and fill in the fields (severity, appeal status, etc. are dropdowns).
2. The bot replies (only you can see it) asking for screenshots.
3. Upload one or more images **in the same channel** within **2 minutes**.
4. Each upload message is **auto-deleted** so the channel stays clean.
5. Type `done` when finished — or just wait, and it auto-logs when the 2 minutes are up.
6. The bot writes the row + posts the embed to the ban log channel, pinging senior
   staff if the severity is **HIGH / CRITICAL / PERMANENT**.

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
│   ├── index.js            # Bot entry point: logs in, routes slash commands, evidence flow
│   ├── deploy-commands.js  # Registers the slash commands with Discord (run once)
│   ├── sheets.js           # All Google Sheets reads/writes + cell styling + auto-ID
│   └── embeds.js           # Builds the Discord embeds (ban, war, appeal, lookups)
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
   (Manage Messages lets the bot auto-delete evidence uploads), and `Mention Everyone`
   if you want senior-role pings to work.
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
BAN_LOG_CHANNEL_ID=     # Channel where ban embeds are posted
WAR_LOG_CHANNEL_ID=     # Channel where war/raid embeds are posted
SENIOR_ROLE_IDS=        # Comma-separated role IDs to ping for HIGH/CRITICAL/PERMANENT bans
SPREADSHEET_ID=         # From the sheet URL: docs.google.com/spreadsheets/d/<THIS>/edit
BAN_SHEET_NAME=Ban Logs
WAR_SHEET_NAME=War & Raid Approvals
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
```

> Re-run `npm run deploy` any time you add/remove/rename a command or its options.

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

---

## 🛣️ Roadmap — Ticket system (planned, not built yet)

We plan to add a **support/report ticket system** next. The rough idea:

- A `/ticket` command (or a button on a pinned message) opens a private thread or
  channel for a player report / ban appeal / staff application.
- Tickets get logged to a **new `Tickets` tab** in the same spreadsheet (status:
  `OPEN` / `IN PROGRESS` / `CLOSED`, assigned staff, category, timestamps).
- Closing a ticket posts a summary embed and archives the thread.
- Likely ties into the existing ban logs (e.g. an appeal ticket links to a `Ban ID`).

When implementing, follow the existing patterns:
- Add the command definition in `src/deploy-commands.js`.
- Put all sheet logic in `src/sheets.js` (reuse `formatRow`, `getSheetId`, the `THEME`).
- Put embed builders in `src/embeds.js`.
- Wire the handler into the router in `src/index.js`.

---

## ⚠️ Security

`.env` and `credentials.json` hold real secrets (bot token + Google key) and are in
`.gitignore`. **Never commit them.** If either leaks, rotate the Discord token and
regenerate the Google service-account key immediately.
