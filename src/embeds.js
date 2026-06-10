const { EmbedBuilder } = require('discord.js');
const { normalizeBanId } = require('./sheets');

const BRAND = 'SovietCraft Staff Logs';
const ZWSP = '​'; // zero-width space, used to pad a 3-column field grid

// Severity → colour (CLAUDE.md spec). Keyed uppercase to match sheet values.
const SEVERITY_COLORS = {
  LOW:       0x57c454, // green
  MEDIUM:    0xf0a500, // amber
  HIGH:      0xe84343, // red
  CRITICAL:  0x8b0000, // dark red
  PERMANENT: 0x1a1a2e, // near-black
};

const STATUS_COLORS = {
  APPROVED: 0x57c454, // green
  DENIED:   0xe84343, // red
  PENDING:  0xf0a500, // amber
};

const SEVERITY_EMOJI = {
  LOW: '🟢', MEDIUM: '🟡', HIGH: '🟠', CRITICAL: '🔴', PERMANENT: '🟣',
};
const STATUS_EMOJI = {
  APPROVED: '✅', DENIED: '⛔', PENDING: '⏳',
};
const APPEAL_EMOJI = {
  Appealable: '✅', Unappealable: '⛔', 'N/A': '➖',
};
const TYPE_EMOJI = { raid: '⚔️', war: '🏴' };

const BLURPLE = 0x5865f2;
const NEUTRAL = 0x2b2d31;

const up = v => String(v ?? '').toUpperCase();
const severityColor = v => SEVERITY_COLORS[up(v)] ?? NEUTRAL;
const statusColor   = v => STATUS_COLORS[up(v)] ?? NEUTRAL;

function severityLabel(v) {
  return `${SEVERITY_EMOJI[up(v)] ?? '⚪'} ${up(v) || '—'}`;
}
function statusLabel(v) {
  return `${STATUS_EMOJI[up(v)] ?? '⚪'} ${up(v) || '—'}`;
}
function appealLabel(v) {
  return `${APPEAL_EMOJI[v] ?? '•'} ${v || '—'}`;
}
function typeMeta(type) {
  const key = String(type).toLowerCase();
  return { emoji: TYPE_EMOJI[key] ?? '⚔️', label: type || 'War/Raid' };
}

// Splits a stored evidence cell (newline/comma separated) into clean URLs.
function parseEvidence(value) {
  if (!value) return [];
  return String(value).split(/[\n,]+/).map(u => u.trim()).filter(Boolean);
}

function applyEvidence(embed, urls) {
  if (urls.length === 0) {
    embed.addFields({ name: '📎 Evidence', value: '`none attached`' });
    return;
  }
  embed.setImage(urls[0]);
  const lines = urls.map((u, i) => `[Screenshot ${i + 1}](${u})`).join('  ·  ');
  embed.addFields({ name: `📎 Evidence (${urls.length})`, value: lines });
}

// A blank inline field to keep the 3-column grid aligned.
const spacer = () => ({ name: ZWSP, value: ZWSP, inline: true });

// ── Ban embed ─────────────────────────────────────────────────────────────────
function buildBanEmbed(data, evidenceUrls = [], staffMention) {
  const id = normalizeBanId(data.ban_id);
  const embed = new EmbedBuilder()
    .setColor(severityColor(data.severity))
    .setAuthor({ name: `🔨 ${BRAND} · Ban Log` })
    .setTitle(`Ban Logged — ID: ${id}`)
    .setDescription(`**${data.player_banned}** has been banned.`)
    .addFields(
      { name: '👤 Player',   value: `\`${data.player_banned}\``, inline: true },
      { name: '⚠️ Severity', value: severityLabel(data.severity), inline: true },
      { name: '⏳ Duration', value: `\`${data.duration || '—'}\``, inline: true },

      { name: '🛡️ Staff',    value: staffMention || `\`${data.staff_member}\``, inline: true },
      { name: '📅 Date',     value: `\`${data.date || '—'}\``, inline: true },
      { name: '📂 Appeal',   value: appealLabel(data.appeal_status), inline: true },

      { name: '📋 Offense',  value: data.offense || '—', inline: false },
    )
    .setFooter({ text: `${BRAND} • Ban ID: ${id}` })
    .setTimestamp();

  applyEvidence(embed, evidenceUrls);
  return embed;
}

// ── War / Raid embed ──────────────────────────────────────────────────────────
function buildWarEmbed(data, approvedByMention) {
  const { emoji, label } = typeMeta(data.type);
  const embed = new EmbedBuilder()
    .setColor(statusColor(data.status))
    .setAuthor({ name: `${emoji} ${BRAND} · War & Raid Approvals` })
    .setTitle(`${label} Logged`)
    .setDescription(`**${data.requesting_team}** → **${data.target_team}**`)
    .addFields(
      { name: '🏷️ Type',       value: `\`${data.type || '—'}\``, inline: true },
      { name: '📌 Status',     value: statusLabel(data.status), inline: true },
      { name: '🧑‍⚖️ Approved By', value: approvedByMention || `\`${data.approved_by}\``, inline: true },

      { name: '🟢 Requesting', value: `\`${data.requesting_team || '—'}\``, inline: true },
      { name: '🔴 Target',     value: `\`${data.target_team || '—'}\``, inline: true },
      { name: '📅 Date',       value: `\`${data.date || '—'}\``, inline: true },

      { name: '📋 Reason',     value: data.reason || '—', inline: false },
    );

  const extras = [];
  if (data.cooldown_ends) extras.push({ name: '🧊 Cooldown Ends', value: `\`${data.cooldown_ends}\``, inline: true });
  if (data.war_duration)  extras.push({ name: '⏱️ War Duration',  value: `\`${data.war_duration}\``, inline: true });
  if (extras.length === 1) extras.push(spacer(), spacer());
  if (extras.length === 2) extras.push(spacer());
  if (extras.length) embed.addFields(...extras);

  if (data.outcome_notes) embed.addFields({ name: '📝 Outcome / Notes', value: data.outcome_notes, inline: false });

  embed.setFooter({ text: `${BRAND} • ${label}` }).setTimestamp();
  return embed;
}

// ── Appeal update embed ─────────────────────────────────────────────────────────
function buildAppealUpdateEmbed(banId, newStatus) {
  const id = normalizeBanId(banId);
  return new EmbedBuilder()
    .setColor(BLURPLE)
    .setAuthor({ name: `📂 ${BRAND} · Appeal Update` })
    .setTitle('Appeal Status Updated')
    .addFields(
      { name: '🆔 Ban ID',    value: `\`ID: ${id}\``, inline: true },
      { name: '📂 New Status', value: appealLabel(newStatus), inline: true },
    )
    .setFooter({ text: `${BRAND} • Ban ID: ${id}` })
    .setTimestamp();
}

// ── Lookup embeds ─────────────────────────────────────────────────────────────
function buildBanLookupEmbed(ban) {
  const id = normalizeBanId(ban.ban_id);
  const embed = new EmbedBuilder()
    .setColor(severityColor(ban.severity))
    .setAuthor({ name: `🔍 ${BRAND} · Ban Record` })
    .setTitle(`Ban Record — ID: ${id}`)
    .addFields(
      { name: '👤 Player',   value: `\`${ban.player_banned}\``, inline: true },
      { name: '⚠️ Severity', value: severityLabel(ban.severity), inline: true },
      { name: '⏳ Duration', value: `\`${ban.duration || '—'}\``, inline: true },

      { name: '🛡️ Staff',    value: `\`${ban.staff_member}\``, inline: true },
      { name: '📅 Date',     value: `\`${ban.date || '—'}\``, inline: true },
      { name: '📂 Appeal',   value: appealLabel(ban.appeal_status), inline: true },

      { name: '📋 Offense',  value: ban.offense || '—', inline: false },
    )
    .setFooter({ text: `${BRAND} • Ban ID: ${id}` })
    .setTimestamp();

  applyEvidence(embed, parseEvidence(ban.evidence));
  return embed;
}

function buildWarLookupEmbed(war) {
  const { emoji, label } = typeMeta(war.type);
  const embed = new EmbedBuilder()
    .setColor(statusColor(war.status))
    .setAuthor({ name: `🔍 ${BRAND} · War & Raid Record` })
    .setTitle(`${emoji} ${label} Record`)
    .addFields(
      { name: '🏷️ Type',       value: `\`${war.type || '—'}\``, inline: true },
      { name: '📌 Status',     value: statusLabel(war.status), inline: true },
      { name: '🧑‍⚖️ Approved By', value: `\`${war.approved_by || '—'}\``, inline: true },

      { name: '🟢 Requesting', value: `\`${war.requesting_team || '—'}\``, inline: true },
      { name: '🔴 Target',     value: `\`${war.target_team || '—'}\``, inline: true },
      { name: '📅 Date',       value: `\`${war.date || '—'}\``, inline: true },

      { name: '📋 Reason',     value: war.reason || '—', inline: false },
    );

  if (war.cooldown_ends) embed.addFields({ name: '🧊 Cooldown Ends', value: `\`${war.cooldown_ends}\``, inline: true });
  if (war.war_duration)  embed.addFields({ name: '⏱️ War Duration',  value: `\`${war.war_duration}\``, inline: true });
  if (war.outcome_notes) embed.addFields({ name: '📝 Outcome / Notes', value: war.outcome_notes, inline: false });

  embed.setFooter({ text: `${BRAND} • ${label}` }).setTimestamp();
  return embed;
}

// ── Confirmation embed (sent back to staff) ─────────────────────────────────────
function buildConfirmEmbed(data) {
  return new EmbedBuilder()
    .setColor(0x57c454)
    .setAuthor({ name: `✅ ${BRAND}` })
    .setTitle('Ban Logged Successfully')
    .setDescription(`Ban **${data.ban_id}** for \`${data.player_banned}\` has been recorded and posted.`)
    .setTimestamp();
}

module.exports = {
  buildBanEmbed,
  buildWarEmbed,
  buildAppealUpdateEmbed,
  buildBanLookupEmbed,
  buildWarLookupEmbed,
  buildConfirmEmbed,
};
