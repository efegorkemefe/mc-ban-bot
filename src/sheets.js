const { google } = require('googleapis');
const path = require('path');

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const BAN_SHEET_NAME = process.env.BAN_SHEET_NAME || 'Ban Logs';
const WAR_SHEET_NAME = process.env.WAR_SHEET_NAME || 'War & Raid Approvals';
// Tab that records verified Minecraft accounts (IGN ↔ UUID ↔ Discord). Created
// automatically on first write if it doesn't exist yet.
const VERIFIED_SHEET_NAME = process.env.VERIFIED_SHEET_NAME || 'Verified Players';

// Real logs live BELOW the example rows + divider. Both tabs have a title row,
// a header row, three [EXAMPLE] rows, then a divider — so real data starts at
// row 7 for bans and row 8 for war/raids.
const BAN_DATA_START_ROW = parseInt(process.env.BAN_DATA_START_ROW || '7', 10);
const WAR_DATA_START_ROW = parseInt(process.env.WAR_DATA_START_ROW || '7', 10);
// Staff Roster mirror tab. LEFT BLANK by default — the mirror stays disabled until
// the user creates the tab and sets ROSTER_SHEET_NAME (the API can't write to a
// tab that doesn't exist). Real entries start at row 7, like the ban/war tabs.
const ROSTER_SHEET_NAME = process.env.ROSTER_SHEET_NAME || '';
const ROSTER_DATA_START_ROW = parseInt(process.env.ROSTER_DATA_START_ROW || '7', 10);

// ── Theme / cell formatting ───────────────────────────────────────────────────
// 1:1 replica of the document's own styling (sampled from the example rows and
// legend stamps): Arial, dark theme, row banding by parity, coloured severity /
// status stamps in Arial 9/10 bold.
const THEME = {
  rowOdd:  '#22272e', // sheet rows 3, 5, 7, 9 …
  rowEven: '#2d333b', // sheet rows 4, 6, 8, 10 …
  text:    '#cdd9e5', // normal cell text
  muted:   '#768390', // appeal-status text
  font:    'Arial',
};

// Severity stamps — Arial 9pt bold, centered. Exact colours from the sheet.
const SEVERITY_CELL = {
  LOW:       { bg: '#1a3028', fg: '#56d364' },
  MEDIUM:    { bg: '#2d2208', fg: '#e3b341' },
  HIGH:      { bg: '#2d1b0e', fg: '#f0883e' },
  CRITICAL:  { bg: '#3d1f1f', fg: '#f78166' },
  PERMANENT: { bg: '#271d3d', fg: '#bc8cff' },
};

// War/Raid status stamps — Arial 10pt bold, centered.
const STATUS_CELL = {
  APPROVED: { bg: '#1a3028', fg: '#56d364' },
  DENIED:   { bg: '#3d1f1f', fg: '#f78166' },
  PENDING:  { bg: '#2d2208', fg: '#e3b341' },
};

// ── Staff Roster stamps ──────────────────────────────────────────────────────
// Kept SEPARATE from the ban/war stamps above so restyling one tab never breaks
// the other. Arial 9pt bold centered (same weight as the severity stamps).
// Tier — Staff = blue, Senior = orange, Super = purple.
const TIER_CELL = {
  1: { bg: '#0d2538', fg: '#6cb6ff' },
  2: { bg: '#2d1b0e', fg: '#f0883e' },
  3: { bg: '#271d3d', fg: '#bc8cff' },
};
// Status — Active = green, LOA = grey, Suspended = red, Exempt = teal.
const ROSTER_STATUS_CELL = {
  active:    { bg: '#1a3028', fg: '#56d364' },
  loa:       { bg: '#2d333b', fg: '#adbac7' },
  suspended: { bg: '#3d1f1f', fg: '#f78166' },
  exempt:    { bg: '#0c2b2b', fg: '#56d4dd' },
};
// Weekly Quota — Met = green, Missed = red, Exempt = teal, N/A (no quota set) = grey.
const QUOTA_CELL = {
  met:       { bg: '#1a3028', fg: '#56d364' },
  missed:    { bg: '#3d1f1f', fg: '#f78166' },
  exempt:    { bg: '#0c2b2b', fg: '#56d4dd' },
  untracked: { bg: '#2d333b', fg: '#768390' },
};
// Promotion — Eligible = gold stamp (a colour used nowhere else on the tab so it
// reads at a glance); otherwise plain muted "Not Eligible" text (no stamp).
const PROMO_CELL = {
  eligible: { bg: '#2d2208', fg: '#e3b341' },
};

// Cell text for the stamped columns. Full tier names + plain words to match the
// example rows ("Staff" / "Senior Staff" / "Super Staff") — professional, no emojis.
const TIER_LABEL = { 1: 'Staff', 2: 'Senior Staff', 3: 'Super Staff' };
const ROSTER_STATUS_LABEL = { active: 'Active', loa: 'LOA', suspended: 'Suspended', exempt: 'Exempt' };
const QUOTA_LABEL = { met: 'Met', missed: 'Missed', exempt: 'Exempt', untracked: 'N/A' };

// Tenure reads "<n> Days" (singular "1 Day"), matching the example-row wording.
function tenureLabel(days) {
  const n = Number(days) || 0;
  return `${n} ${n === 1 ? 'Day' : 'Days'}`;
}

// Subtle cell dividers for the roster tab (the thin grid lines on the example
// rows). Applied to every roster cell so the generated rows match the examples.
const ROSTER_DIVIDER = '#444c56';
function rosterBorders() {
  const side = { style: 'SOLID', color: hexToColor(ROSTER_DIVIDER) };
  return { top: side, bottom: side, left: side, right: side };
}

function hexToColor(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return { red: ((n >> 16) & 255) / 255, green: ((n >> 8) & 255) / 255, blue: (n & 255) / 255 };
}

// Cache of tab name → numeric sheetId (needed for formatting requests).
let _sheetIdCache = null;
async function getSheetId(sheetName) {
  if (!_sheetIdCache) {
    const sheets = await getSheetsClient();
    const meta = await withRetry(() => sheets.spreadsheets.get({
      spreadsheetId: SPREADSHEET_ID,
      fields: 'sheets.properties(sheetId,title)',
    }));
    _sheetIdCache = {};
    for (const s of meta.data.sheets) _sheetIdCache[s.properties.title] = s.properties.sheetId;
  }
  return _sheetIdCache[sheetName];
}

// Builds a full userEnteredFormat matching the document base style. Pass `borders`
// (a Borders object) to draw cell dividers; omit it to leave borders untouched
// (ban/war tabs) — the field is only written when FMT_FIELDS_BORDERS is used.
function cellFormat({ bg, fg = THEME.text, fontSize = 10, bold = false, hAlign = 'LEFT', borders = null }) {
  const fmt = {
    backgroundColor: hexToColor(bg),
    horizontalAlignment: hAlign,
    verticalAlignment: 'MIDDLE',
    wrapStrategy: 'WRAP',
    textFormat: {
      fontFamily: THEME.font,
      fontSize,
      bold,
      italic: false,
      foregroundColor: hexToColor(fg),
    },
  };
  if (borders) fmt.borders = borders;
  return fmt;
}

const FMT_FIELDS = 'userEnteredFormat(backgroundColor,horizontalAlignment,verticalAlignment,wrapStrategy,textFormat)';
// Same, plus borders — used by the roster mirror so passing/omitting `borders`
// either draws or clears the cell dividers (kept off the shared FMT_FIELDS so the
// ban/war tabs are never touched).
const FMT_FIELDS_BORDERS = `${FMT_FIELDS.slice(0, -1)},borders)`;

// Applies the banded base style across the row, then per-column stamp overrides.
// `overrides` is an array of { col, bg?, fg?, fontSize?, bold?, hAlign? }.
async function formatRow(sheetName, rowNumber, totalCols, overrides = []) {
  const sheets = await getSheetsClient();
  const sheetId = await getSheetId(sheetName);
  if (sheetId === undefined) return; // tab not found — skip formatting silently

  const r = rowNumber - 1;
  const baseBg = rowNumber % 2 === 1 ? THEME.rowOdd : THEME.rowEven;

  const cell = (range, fmt) => ({
    repeatCell: { range: { sheetId, ...range }, cell: { userEnteredFormat: fmt }, fields: FMT_FIELDS },
  });

  const requests = [
    cell(
      { startRowIndex: r, endRowIndex: r + 1, startColumnIndex: 0, endColumnIndex: totalCols },
      cellFormat({ bg: baseBg }),
    ),
  ];

  for (const o of overrides) {
    requests.push(
      cell(
        { startRowIndex: r, endRowIndex: r + 1, startColumnIndex: o.col, endColumnIndex: o.col + 1 },
        cellFormat({ bg: o.bg || baseBg, fg: o.fg, fontSize: o.fontSize, bold: o.bold, hAlign: o.hAlign }),
      ),
    );
  }

  await withRetry(() => sheets.spreadsheets.batchUpdate({ spreadsheetId: SPREADSHEET_ID, requestBody: { requests } }));
}

// ── Auth ────────────────────────────────────────────────────────────────────
function getAuth() {
  return new google.auth.GoogleAuth({
    keyFile: path.join(__dirname, '..', 'credentials.json'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

async function getSheetsClient() {
  const auth = getAuth();
  return google.sheets({ version: 'v4', auth });
}

// Wraps a sheet/tab name + A1 notation into a safely-quoted range.
// Tab names with spaces or "&" (e.g. "War & Raid Approvals") must be quoted.
function range(sheetName, a1) {
  return `'${sheetName.replace(/'/g, "''")}'!${a1}`;
}

// ── Retry / backoff ───────────────────────────────────────────────────────────
// The Sheets API occasionally returns 429 (rate limit) or transient 5xx errors.
// Retries those a few times with exponential backoff so a brief hiccup doesn't
// fail a ban/war log. Non-retryable errors (bad range, auth) throw immediately.
function isRetryable(err) {
  const status = err?.code ?? err?.response?.status ?? err?.status;
  return status === 429 || (typeof status === 'number' && status >= 500 && status < 600);
}

async function withRetry(fn, tries = 3) {
  let lastErr;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === tries - 1) throw err;
      const delay = 300 * 2 ** attempt; // 300ms, 600ms, 1200ms…
      console.warn(`Sheets API call failed (retryable), retrying in ${delay}ms:`, err.message);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// ── Ban ID helpers ────────────────────────────────────────────────────────────
// Stored in the sheet as "ID: 004". We strip the prefix for comparison and
// re-apply it on write so lookups are tolerant of how staff type the id.
function normalizeBanId(input) {
  return String(input ?? '').replace(/^\s*id:\s*/i, '').trim();
}

function formatBanId(input) {
  return `ID: ${normalizeBanId(input)}`;
}

// Zero-pads to match the document style ("ID: 001").
function formatBanIdNum(n) {
  return `ID: ${String(n).padStart(3, '0')}`;
}

// Auto-assigns the next ban ID. Only real logged rows (from BAN_DATA_START_ROW)
// count — the [EXAMPLE] rows above the divider are ignored — so the first real
// ban is ID 1, and it increments from the highest existing id.
async function getNextBanId() {
  const sheets = await getSheetsClient();
  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: range(BAN_SHEET_NAME, `H${BAN_DATA_START_ROW}:H`),
  }));
  const rows = res.data.values || [];
  let max = 0;
  for (const r of rows) {
    const n = parseInt(normalizeBanId(r[0]), 10);
    if (!Number.isNaN(n) && n > max) max = n;
  }
  return max + 1;
}

// Finds the first writable row at/after `startRow`: the first row whose column A
// is empty OR still holds a "START HERE FIRST" placeholder. This keeps real logs
// below the divider and overwrites the placeholders as entries fill in.
async function findNextWriteRow(sheetName, startRow) {
  const sheets = await getSheetsClient();
  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: range(sheetName, `A${startRow}:A`),
    majorDimension: 'COLUMNS',
  }));
  const colA = (res.data.values && res.data.values[0]) || [];
  for (let i = 0; i < colA.length; i++) {
    const v = String(colA[i] || '').trim();
    if (v === '' || /start here/i.test(v)) return startRow + i;
  }
  return startRow + colA.length;
}

// ── Bans sheet ──────────────────────────────────────────────────────────────
// Columns: A Date | B Staff | C Player | D Offense | E Severity | F Duration |
//          G Evidence | H Ban Statistics (ID) | I Appeal Status
// Title row = 1, header row = 2, data starts at row 3.

// Auto-assigns the ban ID, writes the row, formats it, and returns the ban id
// string (e.g. "ID: 001") so the caller can show it in the embed/confirmation.
async function appendBan(data, evidenceUrls = []) {
  const sheets = await getSheetsClient();

  const writeRow = await findNextWriteRow(BAN_SHEET_NAME, BAN_DATA_START_ROW);
  const banId = formatBanIdNum(await getNextBanId());

  const row = [
    data.date,
    data.staff_member,
    data.player_banned,
    data.offense,
    data.severity,
    data.duration,
    evidenceUrls.join('\n'),
    banId,
    data.appeal_status,
  ];

  await withRetry(() => sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: range(BAN_SHEET_NAME, `A${writeRow}:I${writeRow}`),
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] },
  }));

  // E (index 4) = Severity stamp; I (index 8) = Appeal Status (muted, centered).
  await formatRow(BAN_SHEET_NAME, writeRow, 9, [
    SEVERITY_CELL[String(data.severity).toUpperCase()]
      ? { col: 4, ...SEVERITY_CELL[String(data.severity).toUpperCase()], fontSize: 9, bold: true, hAlign: 'CENTER' }
      : { col: 4, fontSize: 9, bold: true, hAlign: 'CENTER' },
    { col: 8, fg: THEME.muted, hAlign: 'CENTER' },
  ]);

  return banId;
}

async function getBanRows() {
  const sheets = await getSheetsClient();
  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: range(BAN_SHEET_NAME, 'A3:I'),
  }));
  return res.data.values || [];
}

// Real ban rows only (from BAN_DATA_START_ROW, below the [EXAMPLE] rows/divider),
// with leftover "START HERE" placeholders skipped. Used by /banlist so example
// data never shows up in the list.
async function getBanRecords() {
  const sheets = await getSheetsClient();
  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: range(BAN_SHEET_NAME, `A${BAN_DATA_START_ROW}:I`),
  }));
  const rows = res.data.values || [];
  return rows.filter(r => {
    const a = String((r && r[0]) || '').trim();
    return a && !/start here/i.test(a);
  });
}

// Returns { rowIndex, rowData } (rowIndex is 1-based sheet row) or null.
async function findBanById(banId) {
  const rows = await getBanRows();
  const target = normalizeBanId(banId).toLowerCase();

  for (let i = 0; i < rows.length; i++) {
    const cell = rows[i][7]; // H — Ban Statistics (ID)
    if (normalizeBanId(cell).toLowerCase() === target) {
      return { rowIndex: i + 3, rowData: rows[i] };
    }
  }
  return null;
}

// Returns all matching rows for a player (column C), oldest first.
async function findBansByPlayer(username) {
  const rows = await getBanRows();
  const target = String(username).toLowerCase();
  const matches = [];

  for (let i = 0; i < rows.length; i++) {
    if ((rows[i][2] || '').toLowerCase() === target) {
      matches.push({ rowIndex: i + 3, rowData: rows[i] });
    }
  }
  return matches;
}

async function updateAppealStatus(banId, newStatus) {
  const result = await findBanById(banId);
  if (!result) return false;

  const sheets = await getSheetsClient();
  await withRetry(() => sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: range(BAN_SHEET_NAME, `I${result.rowIndex}`),
    valueInputOption: 'RAW',
    requestBody: { values: [[newStatus]] },
  }));
  return true;
}

// Updates the evidence cell (column G) for an existing ban. Used to store a
// permanent Discord message link after the evidence has been posted to a channel
// (raw CDN attachment URLs expire, so we never persist those). Returns false if
// the ban id isn't found.
async function updateEvidence(banId, evidenceValue) {
  const result = await findBanById(banId);
  if (!result) return false;

  const sheets = await getSheetsClient();
  await withRetry(() => sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: range(BAN_SHEET_NAME, `G${result.rowIndex}`),
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[evidenceValue]] },
  }));
  return true;
}

function rowToBan(row = []) {
  return {
    date:          row[0] || '',
    staff_member:  row[1] || '',
    player_banned: row[2] || '',
    offense:       row[3] || '',
    severity:      row[4] || '',
    duration:      row[5] || '',
    evidence:      row[6] || '',
    ban_id:        row[7] || '',
    appeal_status: row[8] || '',
  };
}

// ── War & Raid Approvals sheet ────────────────────────────────────────────────
// Columns: A Date | B Type | C Requesting | D Target | E Reason | F Approved By |
//          G Outcome/Notes | H Cooldown Ends | I War Duration | J Status

async function appendWar(data) {
  const sheets = await getSheetsClient();

  const row = [
    data.date,
    data.type,
    data.requesting_team,
    data.target_team,
    data.reason,
    data.approved_by,
    data.outcome_notes || '',
    data.cooldown_ends || '',
    data.war_duration || '',
    data.status,
  ];

  const writeRow = await findNextWriteRow(WAR_SHEET_NAME, WAR_DATA_START_ROW);
  await withRetry(() => sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: range(WAR_SHEET_NAME, `A${writeRow}:J${writeRow}`),
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] },
  }));

  // J (index 9) is the Status stamp column (Arial 10pt bold, centered).
  await formatRow(WAR_SHEET_NAME, writeRow, 10, [
    STATUS_CELL[String(data.status).toUpperCase()]
      ? { col: 9, ...STATUS_CELL[String(data.status).toUpperCase()], fontSize: 10, bold: true, hAlign: 'CENTER' }
      : { col: 9, fontSize: 10, bold: true, hAlign: 'CENTER' },
  ]);
}

async function getWarRows() {
  const sheets = await getSheetsClient();
  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: range(WAR_SHEET_NAME, 'A3:J'),
  }));
  return res.data.values || [];
}

// Searches columns C (requesting) and D (target), oldest first.
async function findWarsByTeam(team) {
  const rows = await getWarRows();
  const target = String(team).toLowerCase();
  const matches = [];

  for (let i = 0; i < rows.length; i++) {
    const requesting = (rows[i][2] || '').toLowerCase();
    const targetCol = (rows[i][3] || '').toLowerCase();
    if (requesting.includes(target) || targetCol.includes(target)) {
      matches.push({ rowIndex: i + 3, rowData: rows[i] });
    }
  }
  return matches;
}

function rowToWar(row = []) {
  return {
    date:            row[0] || '',
    type:            row[1] || '',
    requesting_team: row[2] || '',
    target_team:     row[3] || '',
    reason:          row[4] || '',
    approved_by:     row[5] || '',
    outcome_notes:   row[6] || '',
    cooldown_ends:   row[7] || '',
    war_duration:    row[8] || '',
    status:          row[9] || '',
  };
}

// ── Verified Players sheet (Minecraft IGN ↔ UUID verification) ──────────────────
// Columns: A Discord ID | B Discord Tag | C Minecraft IGN | D UUID | E Verified At.
// The tab is created (with a header row) the first time we need to write to it.

async function ensureVerifiedSheet() {
  const sheets = await getSheetsClient();
  let sheetId = await getSheetId(VERIFIED_SHEET_NAME);
  if (sheetId !== undefined) return sheetId;

  const addRes = await withRetry(() => sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { requests: [{ addSheet: { properties: { title: VERIFIED_SHEET_NAME } } }] },
  }));
  sheetId = addRes.data.replies?.[0]?.addSheet?.properties?.sheetId;
  if (_sheetIdCache) _sheetIdCache[VERIFIED_SHEET_NAME] = sheetId;

  await withRetry(() => sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: range(VERIFIED_SHEET_NAME, 'A1:E1'),
    valueInputOption: 'RAW',
    requestBody: { values: [['Discord ID', 'Discord Tag', 'Minecraft IGN', 'UUID', 'Verified At']] },
  }));
  return sheetId;
}

// Records (or updates, matched by Discord ID) a verified player. Best-effort:
// callers should catch and log so a sheet hiccup never blocks approval.
async function recordVerifiedPlayer({ discordId, discordTag = '', ign, uuid }) {
  await ensureVerifiedSheet();
  const sheets = await getSheetsClient();

  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: range(VERIFIED_SHEET_NAME, 'A2:E'),
  }));
  const rows = res.data.values || [];
  const row = [String(discordId || ''), discordTag, ign || '', uuid || '', new Date().toISOString()];

  let rowIndex = null;
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][0] || '') === String(discordId)) { rowIndex = i + 2; break; }
  }

  if (rowIndex) {
    await withRetry(() => sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: range(VERIFIED_SHEET_NAME, `A${rowIndex}:E${rowIndex}`),
      valueInputOption: 'RAW',
      requestBody: { values: [row] },
    }));
  } else {
    await withRetry(() => sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: range(VERIFIED_SHEET_NAME, 'A2:E'),
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] },
    }));
  }
  return true;
}

// ── Staff Roster mirror (read-only dashboard) ─────────────────────────────────
// One-way, display-only snapshot of the roster (data/roster.json is the source of
// truth — never read back from here). Full-snapshot rewrite each refresh: clears
// everything below the divider, writes every active-staff row, then applies row
// banding + the C/D/E/H stamps in ONE batched call (so a 30-person roster is one
// formatting request, not 30). No-ops (returns false) when the tab doesn't exist
// so the scheduler can warn without ever crashing or blocking a command.
//
// Columns: A Onboard Date | B Staff Member | C Tier | D Status | E Weekly Quota |
//          F Warns | G Strikes | H Promotion | I Tenure (days).
// Each `row`: { onboardDate, tag, tier, statusKey, quotaState, warns, strikes,
//              eligible, tenureDays }.
async function writeRosterMirror(rows = [], { sheetName = ROSTER_SHEET_NAME, startRow = ROSTER_DATA_START_ROW } = {}) {
  if (!sheetName) return false;
  const sheetId = await getSheetId(sheetName);
  if (sheetId === undefined) return false; // tab not created yet — caller warns

  const sheets = await getSheetsClient();
  const TOTAL_COLS = 9;

  // How far the previous snapshot reached, so we can wipe leftover banding when the
  // roster shrinks. findNextWriteRow returns the first empty/placeholder row.
  const prevLastRow = Math.max(startRow, await findNextWriteRow(sheetName, startRow)) - 1;

  // 1) Clear all values below the divider (snapshot — never append).
  await withRetry(() => sheets.spreadsheets.values.clear({
    spreadsheetId: SPREADSHEET_ID,
    range: range(sheetName, `A${startRow}:I`),
  }));

  // 2) Write the new rows.
  if (rows.length) {
    const values = rows.map(r => [
      (r.onboardDate || '').slice(0, 10),
      r.tag || '',
      TIER_LABEL[r.tier] || '—',
      ROSTER_STATUS_LABEL[r.statusKey] || r.statusKey || '',
      QUOTA_LABEL[r.quotaState] || '',
      String(r.warns ?? 0),
      String(r.strikes ?? 0),
      r.eligible ? 'Eligible for Promotion' : 'Not Eligible',
      tenureLabel(r.tenureDays),
    ]);
    await withRetry(() => sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: range(sheetName, `A${startRow}:I${startRow + rows.length - 1}`),
      valueInputOption: 'USER_ENTERED',
      requestBody: { values },
    }));
  }

  // 3) One batched formatting pass (banding + cell dividers + per-column stamps).
  const requests = [];
  const cell = (rowNum, c0, c1, fmt) => requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: rowNum - 1, endRowIndex: rowNum, startColumnIndex: c0, endColumnIndex: c1 },
      cell: { userEnteredFormat: fmt },
      fields: FMT_FIELDS_BORDERS,
    },
  });
  const borders = rosterBorders();

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const rowNum = startRow + i;
    const baseBg = rowNum % 2 === 1 ? THEME.rowOdd : THEME.rowEven;
    // Stamps match the example rows: Arial 10pt bold, centered, with dividers.
    const stamp = s => cellFormat({ bg: s?.bg || baseBg, fg: s?.fg, fontSize: 10, bold: true, hAlign: 'CENTER', borders });
    const center = () => cellFormat({ bg: baseBg, hAlign: 'CENTER', borders });

    cell(rowNum, 0, TOTAL_COLS, cellFormat({ bg: baseBg, borders }));  // A–I base banding + dividers
    cell(rowNum, 2, 3, stamp(TIER_CELL[r.tier]));                      // C Tier
    cell(rowNum, 3, 4, stamp(ROSTER_STATUS_CELL[r.statusKey]));        // D Status
    cell(rowNum, 4, 5, stamp(QUOTA_CELL[r.quotaState]));               // E Weekly Quota
    cell(rowNum, 5, 6, center());                                      // F Warns (centered)
    cell(rowNum, 6, 7, center());                                      // G Strikes (centered)
    cell(rowNum, 7, 8, r.eligible                                      // H Promotion
      ? stamp(PROMO_CELL.eligible)
      : cellFormat({ bg: baseBg, fg: THEME.muted, hAlign: 'CENTER', borders }));
    cell(rowNum, 8, 9, center());                                      // I Tenure (centered)
  }

  // Clear banding AND dividers on rows a previous (larger) snapshot used but this
  // one doesn't — omitting `borders` writes the cleared-border field via FMT_FIELDS_BORDERS.
  for (let rowNum = startRow + rows.length; rowNum <= prevLastRow; rowNum++) {
    const baseBg = rowNum % 2 === 1 ? THEME.rowOdd : THEME.rowEven;
    cell(rowNum, 0, TOTAL_COLS, cellFormat({ bg: baseBg }));
  }

  if (requests.length) {
    await withRetry(() => sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests },
    }));
  }
  return true;
}

module.exports = {
  normalizeBanId,
  formatBanId,
  appendBan,
  getBanRecords,
  findBanById,
  findBansByPlayer,
  updateAppealStatus,
  updateEvidence,
  rowToBan,
  appendWar,
  getWarRows,
  findWarsByTeam,
  rowToWar,
  VERIFIED_SHEET_NAME,
  ensureVerifiedSheet,
  recordVerifiedPlayer,
  writeRosterMirror,
};
