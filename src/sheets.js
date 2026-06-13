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

// Builds a full userEnteredFormat matching the document base style.
function cellFormat({ bg, fg = THEME.text, fontSize = 10, bold = false, hAlign = 'LEFT' }) {
  return {
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
}

const FMT_FIELDS = 'userEnteredFormat(backgroundColor,horizontalAlignment,verticalAlignment,wrapStrategy,textFormat)';

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
};
