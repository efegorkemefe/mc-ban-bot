const { EmbedBuilder } = require('discord.js');
const { normalizeBanId } = require('./sheets');
const { computeBanEnd } = require('./duration');

// ── Branding (configurable via .env) ────────────────────────────────────────────
// Lets server owners rebrand the bot without touching code.
const BRAND_NAME = process.env.BRAND_NAME || 'SovietCraft';
const BRAND_ICON = process.env.BRAND_ICON_URL || null;
const BRAND_COLOR = (() => {
  const raw = (process.env.BRAND_COLOR || '').replace('#', '').trim();
  const n = parseInt(raw, 16);
  return Number.isNaN(n) ? 0x5865f2 : n;
})();

const BRAND = `${BRAND_NAME} Staff Logs`;
const ZWSP = '​'; // zero-width space, used to pad a 3-column field grid

// Author / footer objects that carry the brand icon when one is configured.
const brandAuthor = name => (BRAND_ICON ? { name, iconURL: BRAND_ICON } : { name });
const brandFooter = text => (BRAND_ICON ? { text, iconURL: BRAND_ICON } : { text });

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

// Renders the evidence field. `urls` are clickable links (e.g. a permanent
// archive-message link, or per-screenshot URLs); `imageUrl` is what to render
// inline (an `attachment://name` reference keeps the preview permanent); `count`
// overrides the displayed screenshot count when the files are attached to the
// message rather than linked.
function applyEvidence(embed, { urls = [], imageUrl = null, count = null } = {}) {
  const n = count != null ? count : urls.length;
  if (n === 0) {
    embed.addFields({ name: '📎 Evidence', value: '`none attached`' });
    return;
  }
  if (imageUrl) embed.setImage(imageUrl);
  else if (urls.length) embed.setImage(urls[0]);

  const value = urls.length
    ? urls.map((u, i) => `[Screenshot ${i + 1}](${u})`).join('  ·  ')
    : `\`${n}\` screenshot(s) attached above`;
  embed.addFields({ name: `📎 Evidence (${n})`, value });
}

// A blank inline field to keep the 3-column grid aligned.
const spacer = () => ({ name: ZWSP, value: ZWSP, inline: true });

// ── Ban expiry helpers ──────────────────────────────────────────────────────────
// Turn a ban's date + duration into a human "when does it end" string using
// Discord's auto-localizing timestamps (<t:unix:…>).
function banEndValue(ban) {
  const info = computeBanEnd(ban.date, ban.duration);
  if (info.state === 'permanent') return '🔒 Never · permanent';
  if (info.state === 'unknown') return '`—`';
  const sec = Math.floor(info.endMs / 1000);
  return info.state === 'ended'
    ? `<t:${sec}:D> · ✅ expired`
    : `<t:${sec}:D> (<t:${sec}:R>)`;
}

// Compact one-liner variant for list views.
function banEndShort(ban) {
  const info = computeBanEnd(ban.date, ban.duration);
  if (info.state === 'permanent') return '🔒 permanent';
  if (info.state === 'unknown') return '';
  const sec = Math.floor(info.endMs / 1000);
  return info.state === 'ended' ? '✅ expired' : `ends <t:${sec}:R>`;
}

const inlineEnds = ban => ({ name: '⌛ Ends', value: banEndValue(ban), inline: true });

// One compact line for /banlist: "🔴 `004` **Player** · ends in 3 days · 🔓 lifted".
function banListLine(ban, { lifted = false } = {}) {
  const id = normalizeBanId(ban.ban_id);
  const sev = SEVERITY_EMOJI[up(ban.severity)] ?? '⚪';
  const ends = banEndShort(ban);
  return `${sev} \`${id || '—'}\` **${ban.player_banned || 'Unknown'}**` +
    (ends ? ` · ${ends}` : '') + (lifted ? ' · 🔓 lifted' : '');
}

// One line for /history: "`2026-06-01` 🟠 **offense** · `ID 004` · ends in 3d · 🔓 lifted".
function historyLine(ban, { lifted = false } = {}) {
  const id = normalizeBanId(ban.ban_id);
  const sev = SEVERITY_EMOJI[up(ban.severity)] ?? '⚪';
  const offense = (ban.offense || '—').slice(0, 80);
  const ends = banEndShort(ban);
  return `\`${ban.date || '—'}\` ${sev} **${offense}** · \`ID ${id || '—'}\`` +
    (ends ? ` · ${ends}` : '') + (lifted ? ' · 🔓 lifted' : '');
}

// Player-facing line for /findban — leads with the Ban ID they hand to staff,
// and omits internal details (staff member, evidence).
function myBanLine(ban, { lifted = false } = {}) {
  const id = normalizeBanId(ban.ban_id);
  const sev = SEVERITY_EMOJI[up(ban.severity)] ?? '⚪';
  const status = lifted ? '🔓 lifted' : (banEndShort(ban) || '🔴 active');
  return `**Ban ID: \`${id || '—'}\`** — ${sev} ${up(ban.severity) || '—'} · \`${ban.date || '—'}\` · ${status} · 📂 ${appealLabel(ban.appeal_status)}`;
}

// ── Ban embed ─────────────────────────────────────────────────────────────────
// `evidence` is the options object passed to applyEvidence ({ urls, imageUrl, count }).
function buildBanEmbed(data, evidence = {}, staffMention) {
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

      inlineEnds(data), spacer(), spacer(),

      { name: '📋 Offense',  value: data.offense || '—', inline: false },
    )
    .setFooter({ text: `${BRAND} • Ban ID: ${id}` })
    .setTimestamp();

  applyEvidence(embed, evidence);
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
// `opts.unban` (if the ban has been lifted) = { at, by, reason }.
function buildBanLookupEmbed(ban, { unban = null } = {}) {
  const id = normalizeBanId(ban.ban_id);
  const embed = new EmbedBuilder()
    .setColor(unban ? NEUTRAL : severityColor(ban.severity))
    .setAuthor({ name: `🔍 ${BRAND} · Ban Record` })
    .setTitle(`Ban Record — ID: ${id}`)
    .addFields(
      { name: '👤 Player',   value: `\`${ban.player_banned}\``, inline: true },
      { name: '⚠️ Severity', value: severityLabel(ban.severity), inline: true },
      { name: '⏳ Duration', value: `\`${ban.duration || '—'}\``, inline: true },

      { name: '🛡️ Staff',    value: `\`${ban.staff_member}\``, inline: true },
      { name: '📅 Date',     value: `\`${ban.date || '—'}\``, inline: true },
      { name: '📂 Appeal',   value: appealLabel(ban.appeal_status), inline: true },

      inlineEnds(ban), spacer(), spacer(),

      { name: '📋 Offense',  value: ban.offense || '—', inline: false },
    );

  if (unban) {
    const when = unban.at ? `<t:${Math.floor(Date.parse(unban.at) / 1000)}:R>` : '';
    embed.addFields({
      name: '🔓 Status',
      value: `**Lifted** ${when}${unban.by ? ` by <@${unban.by}>` : ''}` +
        (unban.reason ? `\n> ${unban.reason}` : ''),
      inline: false,
    });
  }

  embed.setFooter({ text: `${BRAND} • Ban ID: ${id}` }).setTimestamp();
  applyEvidence(embed, { urls: parseEvidence(ban.evidence) });
  return embed;
}

// ── /banlist (compact) ──────────────────────────────────────────────────────────
// `lines` is a page's worth of pre-formatted strings; paging metadata controls
// the title/footer. Built by the caller from rowToBan + banEndShort.
function buildBanListEmbed({ lines, page = 0, totalPages = 1, total = 0, scope = 'active' }) {
  return new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setAuthor(brandAuthor(`📋 ${BRAND_NAME} · Ban List`))
    .setTitle(scope === 'active' ? `Currently Banned — ${total}` : `All Bans — ${total}`)
    .setDescription(lines.length ? lines.join('\n') : '_No bans to show._')
    .setFooter(brandFooter(`${BRAND_NAME} • Page ${page + 1}/${totalPages}`))
    .setTimestamp();
}

// ── /history (per-player ban timeline) ──────────────────────────────────────────
function buildHistoryEmbed({ player, lines, page = 0, totalPages = 1, total = 0, activeCount = 0 }) {
  return new EmbedBuilder()
    .setColor(activeCount > 0 ? 0xe84343 : NEUTRAL)
    .setAuthor(brandAuthor(`📜 ${BRAND_NAME} · Player History`))
    .setTitle(`History — ${player}`)
    .setDescription(
      `**${total}** ban(s) on record · **${activeCount}** active.\n\n` +
      (lines.length ? lines.join('\n') : '_No bans on record._'),
    )
    .setFooter(brandFooter(`${BRAND_NAME} • Page ${page + 1}/${totalPages}`))
    .setTimestamp();
}

// ── /findban (player self-service: "what's my ban ID?") ─────────────────────────
function buildMyBansEmbed({ username, lines, anyActive }) {
  return new EmbedBuilder()
    .setColor(anyActive ? 0xe84343 : NEUTRAL)
    .setAuthor(brandAuthor(`🔎 ${BRAND_NAME} · Ban Lookup`))
    .setTitle(`Ban record for ${username}`)
    .setDescription(
      `Found **${lines.length}** ban(s) for **${username}**.\n\n` +
      lines.join('\n') +
      '\n\n**To appeal:** open a **⚖️ Ban Appeal** ticket from the ticket panel and give staff the **Ban ID** shown above.',
    )
    .setFooter(brandFooter(BRAND_NAME))
    .setTimestamp();
}

// Posted to the ban log when a ban is lifted via /unban.
function buildUnbanEmbed({ banId, player, byMention, reason }) {
  const id = normalizeBanId(banId);
  return new EmbedBuilder()
    .setColor(0x57c454)
    .setAuthor({ name: `🔓 ${BRAND} · Ban Lifted` })
    .setTitle(`Ban Lifted — ID: ${id}`)
    .setDescription(`**${player || 'Player'}**'s ban has been lifted by ${byMention}.`)
    .addFields(
      { name: '🆔 Ban ID', value: `\`ID: ${id}\``, inline: true },
      { name: '🔓 Action', value: 'Unbanned', inline: true },
      ...(reason ? [{ name: '📋 Reason', value: reason, inline: false }] : []),
    )
    .setFooter({ text: `${BRAND} • Ban ID: ${id}` })
    .setTimestamp();
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

// ── Ticket system embeds ────────────────────────────────────────────────────────
// Styled to match the ban/war embeds: branded author line, emoji-headed fields,
// colour-coded per ticket type, footer + timestamp.
const TICKET_BRAND = `${BRAND_NAME} Support`;

// The public control panel posted by /ticket-panel. `types` is the ordered list
// of ticket-type definitions ({ emoji, label, description }); `guildIcon` is an
// optional server icon URL used as the embed thumbnail.
function buildPanelEmbed(types, guildIcon) {
  const lines = types
    .map(t => `${t.emoji} **${t.label}**\n> ${t.description}`)
    .join('\n\n');

  const embed = new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setAuthor(brandAuthor(`🎫 ${TICKET_BRAND} · Ticket Center`))
    .setTitle('Open a Ticket')
    .setDescription(
      'Need help, want to apply, or have something to report? Pick the option that best ' +
      'fits your request below and a **private channel** will be opened just for you and our team.\n\n' +
      lines +
      '\n\n*You can only have one open ticket at a time.*',
    )
    .setFooter(brandFooter(`${TICKET_BRAND} • Select a category below to get started`));

  if (guildIcon) embed.setThumbnail(guildIcon);
  return embed;
}

// The opening message posted inside a freshly-created ticket channel. When
// `submitted` is true (e.g. an application collected via a modal), the body
// acknowledges the submission instead of asking the user to provide details.
function buildTicketOpenEmbed(type, ownerMention, prompt, submitted = false, priorityText = '⏺️ Normal') {
  const body = submitted
    ? `Welcome ${ownerMention}! Your application has been received and is shown below. ` +
      `Our staff team has been notified and will review it shortly.`
    : `Welcome ${ownerMention}! Your ticket has been created and our staff team has been notified. ` +
      `Please hang tight — someone will be with you shortly.\n\n` +
      `**To help us assist you faster, please provide:**\n${prompt}`;

  return new EmbedBuilder()
    .setColor(type.color)
    .setAuthor(brandAuthor(`${type.emoji} ${TICKET_BRAND} · ${type.label}`))
    .setTitle(`${type.label} — Ticket Opened`)
    .setDescription(body)
    .addFields(
      { name: '🏷️ Category',  value: `\`${type.label}\``, inline: true },
      { name: '🙋 Opened By',  value: ownerMention, inline: true },
      { name: '📌 Status',     value: '🟢 Open · Unclaimed', inline: true },
      { name: '🚦 Priority',   value: priorityText, inline: true },
    )
    .setFooter(brandFooter(`${TICKET_BRAND} • Use the buttons below to manage this ticket`))
    .setTimestamp();
}

// Returns a copy of an existing ticket-open embed with its Priority field set to
// `priorityLabel` (inserting the field if it isn't present). Used by /priority.
function applyPriorityToOpenEmbed(rawEmbed, priorityLabel) {
  const eb = EmbedBuilder.from(rawEmbed);
  const fields = (eb.data.fields || []).slice();
  const field = { name: '🚦 Priority', value: priorityLabel, inline: true };
  const idx = fields.findIndex(f => f.name && f.name.includes('Priority'));
  if (idx >= 0) fields[idx] = field;
  else fields.push(field);
  eb.setFields(fields);
  return eb;
}

// Renders the AI reviewer's verdict on a whitelist application.
function buildWhitelistReviewEmbed({ approved, confidence, summary, reasons, ownerMention }) {
  const embed = new EmbedBuilder()
    .setColor(approved ? 0x57c454 : 0xe84343)
    .setAuthor(brandAuthor(`🤖 ${TICKET_BRAND} · Automated Whitelist Review`))
    .setTitle(approved ? '✅ Application Approved' : '⛔ Application Not Approved')
    .setDescription(
      (approved
        ? `${ownerMention}, your whitelist application has been **approved** and you have been given the member role. Welcome to SovietCraft! 🎉`
        : `${ownerMention}, your whitelist application was **not approved** at this time.`) +
        (summary ? `\n\n> ${summary}` : ''),
    )
    .addFields({ name: '📊 Confidence', value: `\`${confidence || '—'}\``, inline: true });

  if (Array.isArray(reasons) && reasons.length) {
    embed.addFields({
      name: approved ? '✔️ Notes' : '📋 Reasons',
      value: reasons.map(r => `• ${r}`).join('\n').slice(0, 1024),
      inline: false,
    });
  }

  if (!approved) {
    embed.addFields({
      name: '📣 Want to appeal?',
      value: 'Click **Appeal Decision** below and a staff member will personally review your application.',
      inline: false,
    });
  }

  embed.setFooter(brandFooter(`${TICKET_BRAND} • Automated review`)).setTimestamp();
  return embed;
}

// Posted publicly when a staff member claims a ticket.
function buildTicketClaimEmbed(staffMention) {
  return new EmbedBuilder()
    .setColor(0x57c454)
    .setAuthor(brandAuthor(`🙋 ${TICKET_BRAND} · Ticket Claimed`))
    .setTitle('Ticket Claimed')
    .setDescription(
      `This ticket is now being handled by ${staffMention}.\n\n` +
      `Other staff can still read along, but from here on only ${staffMention} and ` +
      `**senior staff** are able to respond.`,
    )
    .setFooter(brandFooter(TICKET_BRAND))
    .setTimestamp();
}

// Posted publicly when a claimed ticket is released.
function buildTicketUnclaimEmbed(staffMention) {
  return new EmbedBuilder()
    .setColor(0xf0a500)
    .setAuthor(brandAuthor(`🔓 ${TICKET_BRAND} · Ticket Released`))
    .setTitle('Ticket Unclaimed')
    .setDescription(
      `${staffMention} has released this ticket. **All staff** can respond again.`,
    )
    .setFooter(brandFooter(TICKET_BRAND))
    .setTimestamp();
}

// Small generic notice (used for /add, /remove, /rename confirmations).
function buildTicketNoticeEmbed({ title, description, color = BRAND_COLOR, emoji = 'ℹ️' }) {
  return new EmbedBuilder()
    .setColor(color)
    .setAuthor(brandAuthor(`${emoji} ${TICKET_BRAND}`))
    .setTitle(title)
    .setDescription(description)
    .setFooter(brandFooter(TICKET_BRAND))
    .setTimestamp();
}

// Shown inside the channel right before it is deleted on close.
function buildTicketClosingEmbed(info) {
  return new EmbedBuilder()
    .setColor(0xe84343)
    .setAuthor(brandAuthor(`🔒 ${TICKET_BRAND} · Closing Ticket`))
    .setTitle('Ticket Closed')
    .setDescription(
      `This ticket has been closed by ${info.closedByMention}.\n` +
      `A transcript has been saved and this channel will be deleted in a few seconds.`,
    )
    .setFooter(brandFooter(TICKET_BRAND))
    .setTimestamp();
}

// The archive/summary embed posted to the ticket-log channel on close.
function buildTicketCloseLogEmbed(info) {
  const embed = new EmbedBuilder()
    .setColor(NEUTRAL)
    .setAuthor(brandAuthor(`📁 ${TICKET_BRAND} · Ticket Archived`))
    .setTitle(`${info.typeLabel} — Ticket Closed`)
    .addFields(
      { name: '🎟️ Ticket',     value: `\`${info.channelName}\``, inline: true },
      { name: '🏷️ Category',    value: `\`${info.typeLabel}\``, inline: true },
      { name: '🙋 Opened By',   value: info.ownerMention, inline: true },

      { name: '🛡️ Claimed By',  value: info.claimedMention || '`Unclaimed`', inline: true },
      { name: '🔒 Closed By',   value: info.closedByMention, inline: true },
      { name: '💬 Messages',    value: `\`${info.messageCount}\``, inline: true },

      { name: '🕒 Opened',      value: info.openedAt, inline: true },
      { name: '⏱️ Duration',    value: `\`${info.duration}\``, inline: true },
      spacer(),
    );

  if (info.reason) {
    embed.addFields({ name: '📋 Reason', value: info.reason, inline: false });
  }

  embed.setFooter(brandFooter(`${TICKET_BRAND} • Transcript attached`)).setTimestamp();
  return embed;
}

// Inactivity warning posted in a ticket before it is auto-closed.
function buildTicketInactivityEmbed({ idleHours, closeHours }) {
  const remaining = Math.max(1, Math.round(closeHours - idleHours));
  return new EmbedBuilder()
    .setColor(0xf0a500)
    .setAuthor(brandAuthor(`💤 ${TICKET_BRAND} · Inactivity Notice`))
    .setTitle('This ticket has gone quiet')
    .setDescription(
      `There's been no activity for about **${idleHours}h**. If nobody responds, this ticket ` +
      `will be **automatically closed in ~${remaining}h**. Send a message to keep it open.`,
    )
    .setFooter(brandFooter(TICKET_BRAND))
    .setTimestamp();
}

// ── Help panels ─────────────────────────────────────────────────────────────────
// Two standalone, multi-embed info boards meant to be posted (and pinned) in
// public/staff channels respectively. `guildIcon` (optional) is used as a thumbnail.

const RULE = '─────────────────────────────';

// Member / public board — post in #info.
function buildMemberPanel(guildIcon) {
  const header = new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setAuthor(brandAuthor(`🏰 ${BRAND_NAME} · Player Help & Info`))
    .setTitle(`Welcome to ${BRAND_NAME}! 👋`)
    .setDescription(
      'This board is your one-stop guide to getting help on the server — joining the **whitelist**, ' +
      '**reporting** a problem, or **appealing a ban**.\n\n' +
      '> 🎫 All support happens through **tickets**: private channels between you and the staff team.\n' +
      '> 🔒 Only you and staff can see your ticket, and you may have **one open at a time**.\n\n' +
      `**${RULE}**`,
    );
  if (guildIcon) header.setThumbnail(guildIcon);

  const guide = new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setTitle('📖 Player Guide')
    .addFields(
      {
        name: '🎫 How to open a ticket',
        value:
          '1️⃣ Go to the **ticket panel** and click the button that matches your need.\n' +
          '2️⃣ A **private channel** opens just for you and the staff team.\n' +
          '3️⃣ Explain your request — add screenshots and your **in-game name** where it helps.\n' +
          '> Finish or close a ticket before opening another one.',
        inline: false,
      },
      {
        name: '📝 Applying for the whitelist',
        value:
          '1️⃣ Open a **📝 Whitelist Application** ticket.\n' +
          '2️⃣ Answer the questions: your **IGN**, **age**, whether you own an **original (paid)** copy of Minecraft, and **why** you want to join.\n' +
          '3️⃣ Press **📨 Submit for Review** — you may be approved instantly, or sent to staff.\n' +
          '4️⃣ Not approved? Use **Appeal Decision** and a real person will review it.',
        inline: false,
      },
      {
        name: '🎮 Username check & nickname',
        value:
          '• Your **IGN is verified against Mojang** when you submit — make sure it\'s spelled **exactly** right, ' +
          'or you\'ll be asked to resubmit.\n' +
          '• When you\'re approved, your **server nickname is set to your IGN** automatically.',
        inline: false,
      },
      {
        name: '⚖️ Appealing a ban',
        value:
          '1️⃣ Run **`/findban <your IGN>`** to get your **Ban ID**.\n' +
          '2️⃣ Open a **⚖️ Ban Appeal** ticket and type that Ban ID.\n' +
          '3️⃣ Press **🔍 Look Up Ban** so staff can see your record, then calmly explain your case.\n' +
          '> Some bans are marked **Unappealable** — you can still ask, but approval is unlikely.',
        inline: false,
      },
      {
        name: '🔎 Find your Ban ID',
        value:
          '**`/findban <username>`** privately shows the Ban ID(s) on record for that name and whether ' +
          'each is active, expired, or already lifted. Hand the ID to staff when you appeal.',
        inline: false,
      },
      {
        name: '📋 Ticket rules & etiquette',
        value:
          '• Pick the **right category** — mis-filed tickets may be closed.\n' +
          '• Be **respectful and patient**; staff are pinged the moment your ticket opens.\n' +
          '• **No** joke, empty, or duplicate tickets.\n' +
          '• Quiet tickets may be **auto-closed** after a warning — just reply to keep yours open.',
        inline: false,
      },
      {
        name: '⚠️ Warnings',
        value:
          'Breaking the rules can earn a **formal warning** — you\'ll get a **DM** explaining why. ' +
          'Warnings add up, and enough of them can lead to a ban, so check your DMs and follow staff guidance.',
        inline: false,
      },
    )
    .setFooter(brandFooter(`${BRAND_NAME} • Need a hand? Open a ticket and we'll help.`))
    .setTimestamp();

  return [header, guide];
}

// Staff board — post in the staff-only channel.
function buildStaffPanel(guildIcon) {
  const STAFF_RED = 0xe84343;

  const header = new EmbedBuilder()
    .setColor(STAFF_RED)
    .setAuthor(brandAuthor(`🛡️ ${BRAND_NAME} · Staff Handbook`))
    .setTitle('Staff Operations Manual')
    .setDescription(
      'Your complete toolkit for moderation and ticket handling. Pin this in the staff channel.\n\n' +
      '> 🧾 Every ban and war/raid is written to the **Google Sheet** and posted as an embed automatically.\n' +
      '> ⚙️ The bot needs **Manage Channels** + **Manage Roles**, with its role **above** the ticket/member roles.\n\n' +
      `**${RULE}**`,
    );
  if (guildIcon) header.setThumbnail(guildIcon);

  const commands = new EmbedBuilder()
    .setColor(STAFF_RED)
    .setTitle('🧰 Command Reference')
    .addFields(
      {
        name: '🔨 Logging bans',
        value:
          '**`/log-ban`** → fill the fields, then **upload screenshot evidence** in the channel and type `done` ' +
          '(or wait 2 min). The **Ban ID is automatic**; HIGH/CRITICAL/PERMANENT pings senior staff. ' +
          'Evidence is re-hosted so the link never expires.',
        inline: false,
      },
      {
        name: '📂 Appeals & unbans',
        value:
          '**`/update-appeal <id> <status>`** — set Appealable / Unappealable / N/A.\n' +
          '**`/unban <id> [reason]`** — mark a ban **lifted** and announce it in the ban log.',
        inline: false,
      },
      {
        name: '🔍 Lookups & analytics',
        value:
          '**`/lookup-ban`** — by ID or player (shows expiry).\n' +
          '**`/banlist`** — active or all bans, paged.\n' +
          '**`/history <player>`** — a player\'s full ban timeline.\n' +
          '**`/stats`** — server dashboard.  ·  **`/lookup-war`** — war/raid records.',
        inline: false,
      },
      {
        name: '🎫 Ticket management',
        value:
          '**`/claim`** / **`/unclaim`** — lock a ticket to you + senior staff.\n' +
          '**`/add`** / **`/remove`** — control who can see it.\n' +
          '**`/priority <Low|Normal|Urgent>`** — set priority (renames the channel; Urgent pings seniors).\n' +
          '**`/rename`** — rename the channel.  ·  **`/close [reason]`** — save a transcript, then delete.',
        inline: false,
      },
      {
        name: '📝 Whitelist & panels',
        value:
          '**`/wl-accept <user>`** — approve an applicant and grant the member role (sets nickname to a verified IGN).\n' +
          '**`/log-war`** — log a war/raid approval.\n' +
          '**`/ticket-panel`** — post the ticket panel.  ·  **`/info-panel`** / **`/staff-panel`** — post these boards.',
        inline: false,
      },
    )
    .setFooter(brandFooter(`${BRAND_NAME} • Staff reference`))
    .setTimestamp();

  const moderation = new EmbedBuilder()
    .setColor(STAFF_RED)
    .setTitle('🛠️ Moderation & Utility')
    .addFields(
      {
        name: '🔇 Timeouts & warnings',
        value:
          '**`/mute <user> <10m|2h|1d> [reason]`** — silent Discord timeout (max 28d). No logging, no embed.\n' +
          '**`/warn <user> [reason]`** — formal warning; **DMs the user** and logs it locally.\n' +
          '**`/warnings <user>`** — view a user\'s warning history. At the threshold the bot suggests a ban.',
        inline: false,
      },
      {
        name: '🗒️ Player notes',
        value:
          '**`/note <player> <text>`** — attach a **private** note to a Minecraft username (never written to the sheet).\n' +
          '**`/notes <player>`** — list notes (newest first). Notes also appear automatically in **`/lookup-ban`** and **`/history`**.',
        inline: false,
      },
      {
        name: '🚩 Flags & leaderboard',
        value:
          '**`/flags`** — review unresolved alt-detection flags (paged).\n' +
          '**`/resolve-flag <id> [note]`** — mark a flag handled.\n' +
          '**`/leaderboard`** — staff ranked by bans logged (toggle **This Week / All Time**).',
        inline: false,
      },
    )
    .setFooter(brandFooter(`${BRAND_NAME} • Moderation tools`))
    .setTimestamp();

  const automation = new EmbedBuilder()
    .setColor(STAFF_RED)
    .setTitle('🤖 Automation & Safeguards')
    .addFields(
      {
        name: '🔁 Prior-ban alert',
        value: 'Running **`/log-ban`** for a player with previous bans shows you a **prior-history warning** (count + most recent offense) before you submit.',
        inline: false,
      },
      {
        name: '🎮 Minecraft verification',
        value:
          'On whitelist submit, the applicant\'s **IGN is checked against Mojang**. An unknown name is rejected with a resubmit prompt; ' +
          'verified IGN + UUID are saved to the **Verified Players** sheet tab, and approval grants the verified role + sets their nickname.',
        inline: false,
      },
      {
        name: '🕵️ Alt detection',
        value:
          'When a whitelist ticket opens, new accounts (**< MIN_ACCOUNT_AGE_DAYS**) and applicants whose timing matches a recently ' +
          'expired/lifted ban (**REJOIN_WINDOW_DAYS**) are **flagged** with a staff ping. Review with **`/flags`**.',
        inline: false,
      },
      {
        name: '⏰ Reminders & reports',
        value:
          '**Appeal reminders:** open, unclaimed ban appeals older than the threshold are re-pinged every 12h (claim one to stop it).\n' +
          '**Weekly staff report:** every **Monday ~09:00** a digest of bans/wars/tickets per staff posts to the ban-log channel.',
        inline: false,
      },
    )
    .setFooter(brandFooter(`${BRAND_NAME} • Runs automatically`))
    .setTimestamp();

  const workflow = new EmbedBuilder()
    .setColor(STAFF_RED)
    .setTitle('🧭 Workflow & Best Practices')
    .addFields(
      {
        name: '🎫 Handling a ticket',
        value:
          '1️⃣ **Claim** it so others know it\'s yours.\n' +
          '2️⃣ Pull in another staffer with **`/add`** if needed.\n' +
          '3️⃣ Resolve, then **`/close [reason]`** — the transcript is archived automatically.\n' +
          '4️⃣ **`/unclaim`** if you can\'t continue, so someone else can take over.',
        inline: false,
      },
      {
        name: '⚖️ Ban appeals',
        value:
          'When a member opens a **Ban Appeal**, have them press **🔍 Look Up Ban** so the record appears. ' +
          'Review the offense, severity, and evidence, then either **`/unban`** or explain the decision. ' +
          '**Unappealable** bans should rarely be lifted.',
        inline: false,
      },
      {
        name: '⚙️ Setup & config',
        value:
          'Channels/roles are set in `.env`. Optional tuning: inactivity auto-close (`TICKET_INACTIVITY_HOURS`), ' +
          'evidence archive (`EVIDENCE_ARCHIVE_CHANNEL_ID`), warning threshold (`WARN_BAN_THRESHOLD`), ' +
          'appeal reminders (`APPEAL_REMINDER_HOURS`), and alt-detection windows (`MIN_ACCOUNT_AGE_DAYS`, `REJOIN_WINDOW_DAYS`).',
        inline: false,
      },
    )
    .setFooter(brandFooter(`${BRAND_NAME} • Keep it pinned`))
    .setTimestamp();

  return [header, commands, moderation, automation, workflow];
}

// ── /stats ────────────────────────────────────────────────────────────────────
// `bans` = summarizeBans(...), `wars` = summarizeWars(...) from src/stats.js.
function buildStatsEmbed({ bans, wars, openTickets }) {
  const sevLine = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL', 'PERMANENT']
    .filter(k => bans.severity[k]).map(k => `${SEVERITY_EMOJI[k]} ${bans.severity[k]}`).join('   ') || '—';
  const staffLine = bans.topStaff.length
    ? bans.topStaff.map(([name, n], i) => `\`${i + 1}.\` ${name} — **${n}**`).join('\n')
    : '—';
  const warStatusLine = ['APPROVED', 'DENIED', 'PENDING']
    .filter(k => wars.status[k]).map(k => `${STATUS_EMOJI[k]} ${wars.status[k]}`).join('   ') || '—';
  const typeLine = ['war', 'raid']
    .filter(k => wars.type[k]).map(k => `${TYPE_EMOJI[k]} ${wars.type[k]}`).join('   ');

  return new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setAuthor(brandAuthor(`📊 ${BRAND_NAME} · Server Stats`))
    .setTitle('Moderation Dashboard')
    .addFields(
      { name: '🔨 Bans', value: `**${bans.total}** total\n🔴 ${bans.active} active · ✅ ${bans.expired} expired · 🔓 ${bans.lifted} lifted`, inline: true },
      { name: '⚔️ War / Raid', value: `**${wars.total}** total\n${warStatusLine}${typeLine ? `\n${typeLine}` : ''}`, inline: true },
      { name: '🎫 Open Tickets', value: `**${openTickets}**`, inline: true },
      { name: '⚠️ Bans by severity', value: sevLine, inline: false },
      { name: '🛡️ Top staff', value: staffLine, inline: false },
    )
    .setFooter(brandFooter(BRAND_NAME))
    .setTimestamp();
}

// ── /ping ───────────────────────────────────────────────────────────────────────
function buildStatusEmbed({ wsPing, uptime, openTickets, online }) {
  return new EmbedBuilder()
    .setColor(online ? 0x57c454 : 0xf0a500)
    .setAuthor(brandAuthor(`🩺 ${BRAND_NAME} · Status`))
    .setTitle(online ? '🟢 Online' : '🟡 Starting up')
    .addFields(
      { name: '📡 Latency',      value: `\`${wsPing} ms\``, inline: true },
      { name: '⏱️ Uptime',       value: `\`${uptime}\``, inline: true },
      { name: '🎫 Open Tickets', value: `\`${openTickets}\``, inline: true },
    )
    .setFooter(brandFooter(BRAND_NAME))
    .setTimestamp();
}

// ── Moderation / utility embeds (warnings, notes, flags, reports) ───────────────
// Local timestamp helper → Discord relative time, tolerant of bad input.
function relTime(iso) {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? '`unknown`' : `<t:${Math.floor(t / 1000)}:R>`;
}

// Compact ms → "1h 2m" / "45s" (mirrors tickets.humanizeDuration without the
// circular import).
function humanizeMs(ms) {
  if (ms == null) return '—';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (!parts.length) parts.push(`${s}s`);
  return parts.join(' ');
}

const FLAG_META = {
  account_age:   { emoji: '🐣', label: 'New account' },
  rejoin_timing: { emoji: '🕵️', label: 'Ban-rejoin timing' },
  flag:          { emoji: '🚩', label: 'Flag' },
};
const flagMeta = type => FLAG_META[type] || FLAG_META.flag;

// Shown to staff (ephemerally) when /log-ban is run for a player with priors.
function buildPriorBansWarningEmbed(player, bans) {
  const recent = bans[bans.length - 1]; // findBansByPlayer returns oldest-first
  const id = recent ? normalizeBanId(recent.ban_id) : '';
  return new EmbedBuilder()
    .setColor(0xf0a500)
    .setAuthor(brandAuthor(`⚠️ ${BRAND_NAME} · Prior History`))
    .setTitle(`Heads up — ${player} has ${bans.length} prior ban(s)`)
    .setDescription(
      `This player already appears in the ban log **${bans.length}** time(s). ` +
      'Review their history before submitting this ban.',
    )
    .addFields(
      { name: '🧮 Total prior bans', value: `\`${bans.length}\``, inline: true },
      { name: '🆔 Most recent', value: id ? `\`ID: ${id}\`` : '`—`', inline: true },
      { name: '📅 When', value: `\`${recent?.date || '—'}\``, inline: true },
      { name: '📋 Most recent offense', value: (recent?.offense || '—').slice(0, 256), inline: false },
    )
    .setFooter(brandFooter(`${BRAND_NAME} • Run /history ${player} for the full timeline`))
    .setTimestamp();
}

// Auto-surfaced follow-up showing notes and/or unresolved flags for a player.
function buildInsightsEmbed({ player, notes = [], flags = [] }) {
  const embed = new EmbedBuilder()
    .setColor(flags.length ? 0xe84343 : 0xf0a500)
    .setAuthor(brandAuthor(`🗒️ ${BRAND_NAME} · Staff Insights`))
    .setTitle(`Insights — ${player}`)
    .setFooter(brandFooter(`${BRAND_NAME} • Visible to staff only`))
    .setTimestamp();

  if (flags.length) {
    embed.setDescription(`⚠️ This player's IGN has **${flags.length}** unresolved flag(s).`);
    embed.addFields({
      name: '🚩 Unresolved flags',
      value: flags.slice(0, 6).map(f => {
        const m = flagMeta(f.type);
        return `\`#${f.id}\` ${m.emoji} **${m.label}** — ${(f.reason || '—').slice(0, 140)} · ${relTime(f.at)}`;
      }).join('\n').slice(0, 1024),
      inline: false,
    });
  }

  if (notes.length) {
    embed.addFields({
      name: `🗒️ Staff notes (${notes.length})`,
      value: notes.slice(0, 5).map(n =>
        `• ${n.text.slice(0, 180)}\n  — ${n.by ? `<@${n.by}>` : n.byTag || 'staff'} · ${relTime(n.at)}`,
      ).join('\n').slice(0, 1024),
      inline: false,
    });
  }

  return embed;
}

// /notes — full notes list for a player (newest first).
function buildNotesEmbed({ player, notes }) {
  return new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setAuthor(brandAuthor(`🗒️ ${BRAND_NAME} · Staff Notes`))
    .setTitle(`Notes — ${player}`)
    .setDescription(
      (notes.length
        ? notes.slice(0, 15).map(n =>
            `**\`#${n.id}\`** ${relTime(n.at)} — ${n.by ? `<@${n.by}>` : n.byTag || 'staff'}\n> ${n.text.slice(0, 300)}`,
          ).join('\n\n')
        : '_No notes on record._'
      ).slice(0, 4096),
    )
    .setFooter(brandFooter(`${BRAND_NAME} • ${notes.length} note(s) · staff only`))
    .setTimestamp();
}

// /flags — a page of unresolved flags.
function buildFlagsListEmbed({ flags, page = 0, totalPages = 1, total = 0 }) {
  return new EmbedBuilder()
    .setColor(0xe84343)
    .setAuthor(brandAuthor(`🚩 ${BRAND_NAME} · Unresolved Flags`))
    .setTitle(`Open Flags — ${total}`)
    .setDescription(
      (flags.length
        ? flags.map(f => {
            const m = flagMeta(f.type);
            const who = f.discordId ? `<@${f.discordId}>` : '`unknown`';
            const ign = f.ign ? ` · IGN \`${f.ign}\`` : '';
            return `**\`#${f.id}\`** ${m.emoji} **${m.label}** — ${who}${ign} · ${relTime(f.at)}\n> ${(f.reason || '—').slice(0, 220)}`;
          }).join('\n\n')
        : '_No unresolved flags._'
      ).slice(0, 4096),
    )
    .setFooter(brandFooter(`${BRAND_NAME} • Page ${page + 1}/${totalPages} · resolve with /resolve-flag`))
    .setTimestamp();
}

function buildFlagResolvedEmbed(flag) {
  const m = flagMeta(flag.type);
  return new EmbedBuilder()
    .setColor(0x57c454)
    .setAuthor(brandAuthor(`✅ ${BRAND_NAME} · Flag Resolved`))
    .setTitle(`Flag #${flag.id} resolved`)
    .addFields(
      { name: '🚩 Type', value: `${m.emoji} ${m.label}`, inline: true },
      { name: '👤 User', value: flag.discordId ? `<@${flag.discordId}>` : '`unknown`', inline: true },
      { name: '🎮 IGN', value: flag.ign ? `\`${flag.ign}\`` : '`—`', inline: true },
      ...(flag.resolvedNote ? [{ name: '🗒️ Note', value: flag.resolvedNote.slice(0, 512), inline: false }] : []),
    )
    .setFooter(brandFooter(BRAND_NAME))
    .setTimestamp();
}

// In-channel flag posts (account age / rejoin timing).
function buildAccountAgeFlagEmbed({ userMention, ageDays, minDays, flagId }) {
  return new EmbedBuilder()
    .setColor(0xf0a500)
    .setAuthor(brandAuthor(`🐣 ${TICKET_BRAND} · Account Flag`))
    .setTitle('New Discord account flagged')
    .setDescription(
      `${userMention}'s Discord account is only **${ageDays} day(s)** old (threshold **${minDays}**). ` +
      'This is a heads-up for staff — the application can still proceed.',
    )
    .addFields(
      { name: '📅 Account age', value: `\`${ageDays} day(s)\``, inline: true },
      { name: '🚩 Flag ID', value: `\`#${flagId}\``, inline: true },
    )
    .setFooter(brandFooter(`${TICKET_BRAND} • Review with /flags`))
    .setTimestamp();
}

function buildRejoinFlagEmbed({ userMention, recent, flagId }) {
  const lines = recent.slice(0, 5).map(r =>
    `• \`ID ${normalizeBanId(r.ban.ban_id) || '—'}\` **${r.ban.player_banned || 'Unknown'}** — ${r.how} <t:${Math.floor(r.when / 1000)}:R>`,
  ).join('\n');
  return new EmbedBuilder()
    .setColor(0xe84343)
    .setAuthor(brandAuthor(`🕵️ ${TICKET_BRAND} · Rejoin Timing Flag`))
    .setTitle('Possible ban-evasion timing')
    .setDescription(
      `${userMention} opened a whitelist application shortly after the following ban(s) ended or were lifted. ` +
      'This may be a coincidence — staff should verify before approving.',
    )
    .addFields(
      { name: '🔓 Recently ended / lifted bans', value: lines.slice(0, 1024) || '`—`', inline: false },
      { name: '🚩 Flag ID', value: `\`#${flagId}\``, inline: true },
    )
    .setFooter(brandFooter(`${TICKET_BRAND} • Review with /flags`))
    .setTimestamp();
}

// /warn — DM sent to the warned user.
function buildWarnDmEmbed({ guildName, reason, count, threshold }) {
  const embed = new EmbedBuilder()
    .setColor(0xf0a500)
    .setAuthor(brandAuthor(`⚠️ ${BRAND_NAME} · Warning`))
    .setTitle(`You have received a warning${guildName ? ` in ${guildName}` : ''}`)
    .setDescription(reason ? `> ${reason}` : '_No reason was provided._')
    .addFields({ name: '🧮 Total warnings', value: `\`${count}\``, inline: true })
    .setFooter(brandFooter(BRAND_NAME))
    .setTimestamp();
  if (threshold && count >= threshold) {
    embed.addFields({ name: '🚨 Notice', value: 'You have reached the warning threshold. Further infractions may result in a ban.', inline: false });
  }
  return embed;
}

// /warnings — a user's warning history.
function buildWarningsEmbed({ user, warnings }) {
  return new EmbedBuilder()
    .setColor(warnings.length ? 0xf0a500 : NEUTRAL)
    .setAuthor(brandAuthor(`⚠️ ${BRAND_NAME} · Warnings`))
    .setTitle(`Warnings — ${user.tag || user.username}`)
    .setDescription(
      (warnings.length
        ? warnings.slice(-15).reverse().map(w =>
            `**\`#${w.id}\`** ${relTime(w.at)} — by ${w.by ? `<@${w.by}>` : w.byTag || 'staff'}\n> ${(w.reason || '_no reason_').slice(0, 300)}`,
          ).join('\n\n')
        : '_No warnings on record — clean slate._'
      ).slice(0, 4096),
    )
    .setFooter(brandFooter(`${BRAND_NAME} • ${warnings.length} warning(s)`))
    .setTimestamp();
}

// /leaderboard — ranked staff by bans logged.
function buildLeaderboardEmbed({ entries, scope = 'all', total = 0 }) {
  const medals = ['🥇', '🥈', '🥉'];
  const lines = entries.slice(0, 15).map(([name, n], i) =>
    `${medals[i] || `\`${String(i + 1).padStart(2, ' ')}.\``} **${name}** — \`${n}\``,
  );
  return new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setAuthor(brandAuthor(`🏆 ${BRAND_NAME} · Ban Leaderboard`))
    .setTitle(scope === 'week' ? 'Top Staff — This Week' : 'Top Staff — All Time')
    .setDescription(lines.length ? lines.join('\n') : '_No bans logged in this period._')
    .setFooter(brandFooter(`${BRAND_NAME} • ${total} ban(s) counted`))
    .setTimestamp();
}

// Weekly staff activity digest. `report` from src/report.js weeklyStaffReport().
function buildWeeklyReportEmbed(report, { weekLabel } = {}) {
  const fmt = pairs => (pairs.length
    ? pairs.slice(0, 8).map(([name, n], i) => `\`${i + 1}.\` ${name} — **${n}**`).join('\n')
    : '_none_');
  const tickets = report.ticketCounts.length
    ? report.ticketCounts.slice(0, 8).map(([name, n], i) => `\`${i + 1}.\` ${name} — **${n}**`).join('\n')
    : '_none_';
  return new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setAuthor(brandAuthor(`📈 ${BRAND_NAME} · Weekly Staff Report`))
    .setTitle('Staff Activity Digest')
    .setDescription(weekLabel ? `Week of **${weekLabel}**` : 'Past week')
    .addFields(
      { name: '🔨 Bans logged', value: fmt(report.banCounts), inline: true },
      { name: '⚔️ Wars logged', value: fmt(report.warCounts), inline: true },
      { name: '🎫 Tickets closed', value: tickets, inline: true },
      { name: '⏱️ Avg first response', value: report.avgFirstResponseMs != null ? `\`${humanizeMs(report.avgFirstResponseMs)}\`` : '`—`', inline: true },
      { name: '📦 Total tickets closed', value: `\`${report.ticketsClosed}\``, inline: true },
    )
    .setFooter(brandFooter(`${BRAND_NAME} • Automated weekly report`))
    .setTimestamp();
}

// /priority — posted in the ticket when its priority changes.
function buildPriorityEmbed({ label, byMention, color = BRAND_COLOR }) {
  return new EmbedBuilder()
    .setColor(color)
    .setAuthor(brandAuthor(`🚦 ${TICKET_BRAND} · Priority Updated`))
    .setTitle('Ticket Priority Updated')
    .setDescription(`Priority set to **${label}** by ${byMention}.`)
    .setFooter(brandFooter(TICKET_BRAND))
    .setTimestamp();
}

// Posted to the ban log channel when an appeal ticket has sat unhandled.
function buildAppealReminderEmbed({ channelMention, ageHours, ownerMention }) {
  return new EmbedBuilder()
    .setColor(0xf0a500)
    .setAuthor(brandAuthor(`⏰ ${BRAND_NAME} · Appeal Reminder`))
    .setTitle('Ban appeal awaiting review')
    .setDescription(
      `A ban appeal from ${ownerMention} in ${channelMention} has been open for about ` +
      `**${ageHours}h** with no staff handling it yet. Please claim and review it.`,
    )
    .setFooter(brandFooter(`${BRAND_NAME} • Claim the ticket to stop these reminders`))
    .setTimestamp();
}

// ── Staff Roster ──────────────────────────────────────────────────────────────
// Branded, dark-theme embeds for the staff roster (profiles, discipline,
// lifecycle, LOA, quota, the Monday digest). All reuse brandAuthor/brandFooter +
// BRAND_COLOR + setTimestamp so they sit visually alongside the ban/ticket embeds.
const ROSTER_BRAND = `${BRAND_NAME} Staff Roster`;
const TIER_LABEL = { 0: 'Not staff', 1: 'Staff', 2: 'Senior Staff', 3: 'Super Staff' };
const TIER_EMOJI = { 1: '🔹', 2: '🔶', 3: '🟣' };
const TIER_COLOR = { 1: 0x5865f2, 2: 0xf0883e, 3: 0xbc8cff };
const ROSTER_STATUS = {
  active:    { emoji: '🟢', label: 'Active',    color: 0x57c454 },
  loa:       { emoji: '🌙', label: 'On LOA',    color: 0x768390 },
  suspended: { emoji: '⛔', label: 'Suspended', color: 0xe84343 },
  exempt:    { emoji: '🛡️', label: 'Exempt',    color: 0x56d4dd },
};

function tierLabel(t) {
  return `${TIER_EMOJI[t] || '▪️'} ${TIER_LABEL[t] || '—'}`;
}
function rosterStatusLabel(s) {
  const m = ROSTER_STATUS[s] || { emoji: '•', label: s || '—' };
  return `${m.emoji} ${m.label}`;
}

// Generic branded roster embed used by most builders below.
function rosterEmbed({ emoji = '📋', title, color = BRAND_COLOR, desc, fields = [], footer }) {
  const e = new EmbedBuilder()
    .setColor(color)
    .setAuthor(brandAuthor(`${emoji} ${ROSTER_BRAND}`))
    .setTitle(title)
    .setFooter(brandFooter(footer || BRAND_NAME))
    .setTimestamp();
  if (desc) e.setDescription(desc);
  if (fields.length) e.addFields(...fields);
  return e;
}

// This-week quota progress vs requirements (only non-zero quotas shown).
function formatQuotaProgress(counters = {}, req = {}) {
  const rows = [];
  const add = (label, key) => {
    if (req[key] > 0) rows.push(`${(counters[key] || 0) >= req[key] ? '✅' : '❌'} ${label} **${counters[key] || 0}/${req[key]}**`);
  };
  add('Bans', 'bans');
  add('Wars', 'wars');
  add('Tickets', 'tickets');
  add('Warns', 'warnsIssued');
  return rows.length ? rows.join('\n') : '_No weekly quotas configured._';
}

// Last few weeks' pass/fail/exempt trend from history.
function formatTrend(history = []) {
  const recent = history.slice(-8);
  if (!recent.length) return '_No history yet._';
  return recent.map(w => (w.exempt ? '➖' : w.passed ? '✅' : '❌')).join(' ');
}

// Promotion-eligibility one-liner.
function eligibilityLine(elig) {
  if (!elig) return '`—`';
  return elig.eligible ? '✅ **Eligible for promotion**' : `⏳ Not yet — ${elig.reasons.join(' · ')}`;
}

// /roster — full staff profile.
function buildRosterProfileEmbed({ tier, displayName, tag, statusKey, tenureDays, activeWarns, activeStrikes, lifetime = {}, quota, req, history, eligibility, activityEnabled }) {
  return rosterEmbed({
    emoji: '🛡️',
    color: TIER_COLOR[tier] || BRAND_COLOR,
    title: displayName || tag,
    desc: `${tierLabel(tier)} · ${rosterStatusLabel(statusKey)}`,
    fields: [
      { name: '🗓️ Tenure', value: `\`${tenureDays}d\` at current tier`, inline: true },
      { name: '⚠️ Active warns', value: `\`${activeWarns}\``, inline: true },
      { name: '⛔ Active strikes', value: `\`${activeStrikes}\``, inline: true },
      { name: `📊 This week${activityEnabled ? '' : ' (tracking paused)'}`, value: formatQuotaProgress(quota, req), inline: true },
      { name: '📈 Recent trend', value: formatTrend(history), inline: true },
      { name: '🏅 Lifetime', value: `🔨 ${lifetime.bans || 0} · ⚔️ ${lifetime.wars || 0} · 🎫 ${lifetime.tickets || 0} · ⚠️ ${lifetime.warnsIssued || 0}`, inline: true },
      { name: '⭐ Promotion', value: eligibilityLine(eligibility), inline: false },
    ],
    footer: `${BRAND_NAME} • ${tag}`,
  });
}

// /roster-list — one page of the active roster.
function buildRosterListEmbed({ rows = [], page = 0, totalPages = 1, total = 0 }) {
  const body = rows.length
    ? rows.map(r => `${tierLabel(r.tier)} — **${r.tag}** · ${r.statusLabel} · ⛔ \`${r.activeStrikes}\``).join('\n')
    : '_No active staff on the roster yet. Onboard someone with `/roster-onboard`._';
  return rosterEmbed({
    emoji: '📋',
    title: `Staff Roster — ${total} member(s)`,
    desc: body.slice(0, 4096),
    footer: `${BRAND_NAME} • Page ${page + 1}/${totalPages}`,
  });
}

// /eligible — staff currently meeting promotion criteria.
function buildEligibleListEmbed({ rows = [], page = 0, totalPages = 1, total = 0 }) {
  const body = rows.length
    ? rows.map(r => `✅ ${tierLabel(r.tier)} — **${r.tag}** · \`${r.tenureDays}d\` · ➡️ ${TIER_LABEL[r.tier + 1] || 'top tier'}`).join('\n')
    : '_No staff currently meet all promotion criteria._';
  return rosterEmbed({
    emoji: '⭐',
    color: 0x57c454,
    title: `Promotion-Eligible Staff — ${total}`,
    desc: body.slice(0, 4096),
    footer: `${BRAND_NAME} • Advisory only — promote by assigning the role`,
  });
}

// DM to a staffer who receives a warn/strike.
function buildStaffActionDmEmbed({ kind, guildName, reason, activeCount, threshold }) {
  const strike = kind === 'strike';
  const e = new EmbedBuilder()
    .setColor(strike ? 0xe84343 : 0xf0a500)
    .setAuthor(brandAuthor(`${strike ? '⛔' : '⚠️'} ${ROSTER_BRAND}`))
    .setTitle(`You received a staff ${strike ? 'strike' : 'warning'}${guildName ? ` in ${guildName}` : ''}`)
    .setDescription(reason ? `> ${reason}` : '_No reason was provided._')
    .addFields({ name: strike ? '⛔ Active strikes' : '⚠️ Active warns', value: `\`${activeCount}\``, inline: true })
    .setFooter(brandFooter(BRAND_NAME))
    .setTimestamp();
  if (threshold && activeCount >= threshold) {
    e.addFields({ name: '🚨 Notice', value: `You have reached the ${strike ? 'strike' : 'warning'} threshold. Senior staff have been notified.`, inline: false });
  }
  return e;
}

// Posted to STAFF_LOG_CHANNEL_ID when a warn/strike is issued.
function buildStaffActionLogEmbed({ kind, targetMention, issuerMention, reason, id, activeCount }) {
  const strike = kind === 'strike';
  return rosterEmbed({
    emoji: strike ? '⛔' : '⚠️',
    color: strike ? 0xe84343 : 0xf0a500,
    title: `Staff ${strike ? 'Strike' : 'Warning'} Issued`,
    fields: [
      { name: '👤 Staff member', value: targetMention, inline: true },
      { name: '🛡️ Issued by', value: issuerMention, inline: true },
      { name: strike ? '⛔ Active strikes' : '⚠️ Active warns', value: `\`${activeCount}\``, inline: true },
      { name: '📋 Reason', value: (reason || '_No reason provided._').slice(0, 1024), inline: false },
    ],
    footer: `${BRAND_NAME} • ${strike ? 'Strike' : 'Warn'} ID: ${id}`,
  });
}

// Posted when a warn/strike is pardoned.
function buildStaffPardonLogEmbed({ type, id, targetMention, issuerMention }) {
  return rosterEmbed({
    emoji: '✅',
    color: 0x57c454,
    title: `Staff ${type === 'strike' ? 'Strike' : 'Warning'} Pardoned`,
    fields: [
      { name: '👤 Staff member', value: targetMention, inline: true },
      { name: '🛡️ Pardoned by', value: issuerMention, inline: true },
    ],
    footer: `${BRAND_NAME} • ${type === 'strike' ? 'Strike' : 'Warn'} ID: ${id}`,
  });
}

// /staff-record — warn/strike history newest-first.
function buildStaffRecordEmbed({ tag, warns = [], strikes = [] }) {
  const fmt = list => (list.length
    ? list.slice().reverse().slice(0, 12).map(x =>
        `\`#${x.id}\` ${relTime(x.timestamp)} — by ${x.issuerId ? `<@${x.issuerId}>` : 'system'}${x.auto ? ' · _auto_' : ''}${x.pardoned ? ' · ✅ _pardoned_' : ''}\n> ${(x.reason || '_no reason_').slice(0, 200)}`,
      ).join('\n\n')
    : '_none_');
  return rosterEmbed({
    emoji: '🗂️',
    title: `Staff Record — ${tag}`,
    fields: [
      { name: `⚠️ Warnings (${warns.filter(w => !w.pardoned).length} active / ${warns.length} total)`, value: fmt(warns).slice(0, 1024), inline: false },
      { name: `⛔ Strikes (${strikes.filter(s => !s.pardoned).length} active / ${strikes.length} total)`, value: fmt(strikes).slice(0, 1024), inline: false },
    ],
  });
}

// Auto-alert to Super Staff when a member reaches the warn/strike threshold.
function buildEscalationEmbed({ targetMention, kind, count, threshold }) {
  return rosterEmbed({
    emoji: '🚨',
    color: 0xe84343,
    title: `Staff ${kind === 'strike' ? 'Strike' : 'Warning'} Threshold Reached`,
    desc: `${targetMention} now has **${count}** active ${kind === 'strike' ? 'strike(s)' : 'warn(s)'} (threshold **${threshold}**). Super Staff should review — the bot takes no automatic action.`,
    footer: `${BRAND_NAME} • Manual review required`,
  });
}

// Welcome DM on onboarding.
function buildOnboardDmEmbed({ guildName, tier }) {
  return new EmbedBuilder()
    .setColor(TIER_COLOR[tier] || BRAND_COLOR)
    .setAuthor(brandAuthor(`🎉 ${ROSTER_BRAND}`))
    .setTitle(`Welcome to the staff team${guildName ? ` — ${guildName}` : ''}!`)
    .setDescription(`You've been onboarded as **${TIER_LABEL[tier]}**. Your activity and tenure are now tracked — use \`/roster\` to view your profile and \`/quota-status\` to check your weekly progress.`)
    .setFooter(brandFooter(BRAND_NAME))
    .setTimestamp();
}

function buildOnboardLogEmbed({ targetMention, tier, byMention }) {
  return rosterEmbed({
    emoji: '🎉', color: TIER_COLOR[tier] || BRAND_COLOR, title: 'Staff Onboarded',
    fields: [
      { name: '👤 New staff', value: targetMention, inline: true },
      { name: '🎚️ Tier', value: tierLabel(tier), inline: true },
      { name: '🛡️ Onboarded by', value: byMention, inline: true },
    ],
  });
}

// Shown (ephemerally) to the onboarder when the user was previously terminated.
function buildPriorTerminationWarnEmbed({ tag, date, reason }) {
  return rosterEmbed({
    emoji: '⚠️', color: 0xe84343, title: 'Previously Terminated',
    desc: `**${tag}** was previously **terminated**${date ? ` on ${String(date).slice(0, 10)}` : ''}.\n> ${reason || '_No reason recorded._'}\n\nPress **Confirm** to onboard them anyway.`,
    footer: `${BRAND_NAME} • Requires confirmation`,
  });
}

function buildOffboardLogEmbed({ targetMention, byMention, reason }) {
  return rosterEmbed({
    emoji: '👋', color: 0x768390, title: 'Staff Offboarded',
    desc: 'Voluntary / clean exit — archived.',
    fields: [
      { name: '👤 Staff member', value: targetMention, inline: true },
      { name: '🛡️ Offboarded by', value: byMention, inline: true },
      { name: '📋 Reason', value: (reason || '_None given._').slice(0, 1024), inline: false },
    ],
  });
}

function buildRosterEditLogEmbed({ targetMention, byMention, field, value }) {
  return rosterEmbed({
    emoji: '✏️', title: 'Roster Entry Edited',
    fields: [
      { name: '👤 Staff member', value: targetMention, inline: true },
      { name: '🛡️ Edited by', value: byMention, inline: true },
      { name: '🔧 Change', value: `\`${field}\` → \`${String(value).slice(0, 200)}\``, inline: false },
    ],
  });
}

function buildSuspendDmEmbed({ guildName, reason, endIso }) {
  return new EmbedBuilder()
    .setColor(0xe84343)
    .setAuthor(brandAuthor(`⛔ ${ROSTER_BRAND}`))
    .setTitle(`You have been suspended${guildName ? ` in ${guildName}` : ''}`)
    .setDescription(reason ? `> ${reason}` : '_No reason was provided._')
    .addFields({ name: '🔁 Reinstated', value: endIso ? `${relTime(endIso)}` : '`Manual`', inline: false })
    .setFooter(brandFooter(`${BRAND_NAME} • Your staff roles are temporarily removed`))
    .setTimestamp();
}

function buildSuspendLogEmbed({ targetMention, byMention, reason, endIso }) {
  return rosterEmbed({
    emoji: '⛔', color: 0xe84343, title: 'Staff Suspended',
    fields: [
      { name: '👤 Staff member', value: targetMention, inline: true },
      { name: '🛡️ Suspended by', value: byMention, inline: true },
      { name: '🔁 Reinstates', value: endIso ? relTime(endIso) : '`Manual`', inline: true },
      { name: '📋 Reason', value: (reason || '_None given._').slice(0, 1024), inline: false },
    ],
  });
}

function buildReinstateDmEmbed({ guildName }) {
  return new EmbedBuilder()
    .setColor(0x57c454)
    .setAuthor(brandAuthor(`🟢 ${ROSTER_BRAND}`))
    .setTitle(`Your suspension has ended${guildName ? ` — ${guildName}` : ''}`)
    .setDescription('Your previous staff role(s) have been restored. Welcome back!')
    .setFooter(brandFooter(BRAND_NAME))
    .setTimestamp();
}

function buildReinstateLogEmbed({ targetMention, byMention, auto }) {
  return rosterEmbed({
    emoji: '🟢', color: 0x57c454, title: auto ? 'Suspension Expired — Reinstated' : 'Suspension Lifted',
    fields: [
      { name: '👤 Staff member', value: targetMention, inline: true },
      { name: auto ? '⏰ Trigger' : '🛡️ Lifted by', value: auto ? 'Automatic (expiry)' : (byMention || '`—`'), inline: true },
    ],
  });
}

function buildSuspensionListEmbed({ rows = [], page = 0, totalPages = 1, total = 0 }) {
  const body = rows.length
    ? rows.map(r => `⛔ **${r.tag}** — reinstates ${r.endIso ? relTime(r.endIso) : '`manual`'}\n> ${(r.reason || '_no reason_').slice(0, 150)}`).join('\n\n')
    : '_No staff are currently suspended._';
  return rosterEmbed({ emoji: '⛔', color: 0xe84343, title: `Suspended Staff — ${total}`, desc: body.slice(0, 4096), footer: `${BRAND_NAME} • Page ${page + 1}/${totalPages}` });
}

function buildTerminateDmEmbed({ guildName, reason }) {
  return new EmbedBuilder()
    .setColor(0x8b0000)
    .setAuthor(brandAuthor(`🛑 ${ROSTER_BRAND}`))
    .setTitle(`Your staff position has been terminated${guildName ? ` in ${guildName}` : ''}`)
    .setDescription(reason ? `> ${reason}` : '_No reason was provided._')
    .setFooter(brandFooter(BRAND_NAME))
    .setTimestamp();
}

function buildTerminateLogEmbed({ targetMention, byMention, reason }) {
  return rosterEmbed({
    emoji: '🛑', color: 0x8b0000, title: 'Staff Terminated',
    desc: 'Permanent removal for cause — archived.',
    fields: [
      { name: '👤 Staff member', value: targetMention, inline: true },
      { name: '🛡️ Terminated by', value: byMention, inline: true },
      { name: '📋 Reason', value: (reason || '_None given._').slice(0, 1024), inline: false },
    ],
  });
}

function buildQuotaStatusEmbed({ tag, quota, req, daysLeft, activityEnabled, exempt }) {
  return rosterEmbed({
    emoji: '📊', title: `Weekly Quota — ${tag}`,
    desc: activityEnabled
      ? (exempt ? '🛡️ You are **exempt** this week — no quota penalty.' : `\`${daysLeft}\` day(s) left this week.`)
      : '⏸️ The activity system is currently **off** — tracking continues, but no strikes are issued.',
    fields: [{ name: '📈 Progress', value: formatQuotaProgress(quota, req), inline: false }],
  });
}

function buildActivityStatusEmbed({ enabled, req }) {
  const reqLines = [];
  const add = (l, k) => { if (req[k] > 0) reqLines.push(`• ${l}: **${req[k]}/week**`); };
  add('Bans', 'bans');
  add('Wars', 'wars');
  add('Tickets', 'tickets');
  add('Warns', 'warnsIssued');
  return rosterEmbed({
    emoji: enabled ? '🟢' : '⏸️', color: enabled ? 0x57c454 : 0x768390,
    title: `Activity System — ${enabled ? 'ON' : 'OFF'}`,
    desc: enabled
      ? 'Weekly quotas are enforced; failing non-exempt staff get an auto-strike each Monday.'
      : 'Activity is still tracked silently, but no auto-strikes are issued while off.',
    fields: [{ name: '🎯 Current weekly quotas', value: reqLines.length ? reqLines.join('\n') : '_None configured (all 0)._', inline: false }],
  });
}

// LOA request posted to the staff log (Approve/Deny buttons added by index.js).
function buildLoaRequestEmbed({ requesterMention, reason, returnDate }) {
  return rosterEmbed({
    emoji: '🌙', color: 0xf0a500, title: 'LOA Request',
    desc: `${requesterMention} is requesting a leave of absence.`,
    fields: [
      { name: '🗓️ Return date', value: returnDate ? `\`${returnDate}\`` : '`Open-ended`', inline: true },
      { name: '📋 Reason', value: (reason || '_None given._').slice(0, 1024), inline: false },
    ],
    footer: `${BRAND_NAME} • Senior staff can approve or deny below`,
  });
}

function buildLoaDecisionDmEmbed({ approved, guildName, reason, returnDate }) {
  return new EmbedBuilder()
    .setColor(approved ? 0x57c454 : 0xe84343)
    .setAuthor(brandAuthor(`🌙 ${ROSTER_BRAND}`))
    .setTitle(`Your LOA request was ${approved ? 'approved' : 'denied'}${guildName ? ` — ${guildName}` : ''}`)
    .setDescription(approved
      ? `Enjoy your time off${returnDate ? ` — see you around \`${returnDate}\`` : ''}. You're exempt from quotas while away.`
      : (reason ? `> ${reason}` : '_No reason was provided._'))
    .setFooter(brandFooter(BRAND_NAME))
    .setTimestamp();
}

function buildLoaLogEmbed({ kind, targetMention, byMention, reason, returnDate }) {
  const meta = {
    requested: { emoji: '🌙', color: 0xf0a500, title: 'LOA Requested' },
    approved:  { emoji: '✅', color: 0x57c454, title: 'LOA Approved' },
    denied:    { emoji: '⛔', color: 0xe84343, title: 'LOA Denied' },
    ended:     { emoji: '🟢', color: 0x57c454, title: 'LOA Ended' },
  }[kind] || { emoji: '🌙', color: BRAND_COLOR, title: 'LOA' };
  const fields = [{ name: '👤 Staff member', value: targetMention, inline: true }];
  if (byMention) fields.push({ name: '🛡️ Actioned by', value: byMention, inline: true });
  if (returnDate) fields.push({ name: '🗓️ Return', value: `\`${returnDate}\``, inline: true });
  if (reason) fields.push({ name: '📋 Reason', value: reason.slice(0, 1024), inline: false });
  return rosterEmbed({ ...meta, fields });
}

function buildLoaListEmbed({ rows = [], page = 0, totalPages = 1, total = 0 }) {
  const body = rows.length
    ? rows.map(r => `🌙 **${r.tag}** — returns ${r.returnDate ? `\`${r.returnDate}\`` : '`open-ended`'}\n> ${(r.reason || '_no reason_').slice(0, 150)}`).join('\n\n')
    : '_No staff are currently on LOA._';
  return rosterEmbed({ emoji: '🌙', color: 0xf0a500, title: `Staff on LOA — ${total}`, desc: body.slice(0, 4096), footer: `${BRAND_NAME} • Page ${page + 1}/${totalPages}` });
}

function buildAutoStrikeDmEmbed({ guildName, weekLabel, activeCount }) {
  return new EmbedBuilder()
    .setColor(0xe84343)
    .setAuthor(brandAuthor(`⛔ ${ROSTER_BRAND}`))
    .setTitle(`Automatic strike — missed weekly quota${guildName ? ` in ${guildName}` : ''}`)
    .setDescription(`You did not meet the activity quota for the week of **${weekLabel}**, so an automatic strike was issued.`)
    .addFields({ name: '⛔ Active strikes', value: `\`${activeCount}\``, inline: true })
    .setFooter(brandFooter(`${BRAND_NAME} • Reach out to senior staff if this is a mistake`))
    .setTimestamp();
}

// Extended Monday digest posted to STAFF_LOG_CHANNEL_ID.
function buildRosterDigestEmbed({ weekLabel, failed = [], loa = [], suspended = [], exempt = [], totalWarns = 0, totalStrikes = 0, activityEnabled }) {
  const list = arr => (arr.length ? arr.map(t => `• ${t}`).join('\n').slice(0, 1024) : '_none_');
  return rosterEmbed({
    emoji: '📒', title: 'Staff Roster Digest',
    desc: `Week of **${weekLabel}** · Activity system: ${activityEnabled ? '🟢 ON' : '⏸️ OFF'}`,
    fields: [
      { name: `❌ Missed quota (auto-struck) — ${failed.length}`, value: list(failed), inline: false },
      { name: `🌙 On LOA — ${loa.length}`, value: list(loa), inline: true },
      { name: `⛔ Suspended — ${suspended.length}`, value: list(suspended), inline: true },
      { name: `🛡️ Exempt (role) — ${exempt.length}`, value: list(exempt), inline: true },
      { name: '🧮 Active discipline totals', value: `⚠️ ${totalWarns} warn(s) · ⛔ ${totalStrikes} strike(s)`, inline: false },
    ],
    footer: `${BRAND_NAME} • Automated roster digest`,
  });
}

module.exports = {
  buildBanEmbed,
  buildWarEmbed,
  buildAppealUpdateEmbed,
  buildBanLookupEmbed,
  buildWarLookupEmbed,
  buildConfirmEmbed,
  // ── Ticket system ──
  buildPanelEmbed,
  buildTicketOpenEmbed,
  buildWhitelistReviewEmbed,
  buildTicketClaimEmbed,
  buildTicketUnclaimEmbed,
  buildTicketNoticeEmbed,
  buildTicketClosingEmbed,
  buildTicketCloseLogEmbed,
  buildMemberPanel,
  buildStaffPanel,
  buildStatusEmbed,
  buildBanListEmbed,
  buildUnbanEmbed,
  buildTicketInactivityEmbed,
  buildStatsEmbed,
  buildHistoryEmbed,
  buildMyBansEmbed,
  banListLine,
  historyLine,
  myBanLine,
  applyPriorityToOpenEmbed,
  // ── Moderation / utility ──
  buildPriorBansWarningEmbed,
  buildInsightsEmbed,
  buildNotesEmbed,
  buildFlagsListEmbed,
  buildFlagResolvedEmbed,
  buildAccountAgeFlagEmbed,
  buildRejoinFlagEmbed,
  buildWarnDmEmbed,
  buildWarningsEmbed,
  buildLeaderboardEmbed,
  buildWeeklyReportEmbed,
  buildPriorityEmbed,
  buildAppealReminderEmbed,
  // ── Staff Roster ──
  buildRosterProfileEmbed,
  buildRosterListEmbed,
  buildEligibleListEmbed,
  buildStaffActionDmEmbed,
  buildStaffActionLogEmbed,
  buildStaffPardonLogEmbed,
  buildStaffRecordEmbed,
  buildEscalationEmbed,
  buildOnboardDmEmbed,
  buildOnboardLogEmbed,
  buildPriorTerminationWarnEmbed,
  buildOffboardLogEmbed,
  buildRosterEditLogEmbed,
  buildSuspendDmEmbed,
  buildSuspendLogEmbed,
  buildReinstateDmEmbed,
  buildReinstateLogEmbed,
  buildSuspensionListEmbed,
  buildTerminateDmEmbed,
  buildTerminateLogEmbed,
  buildQuotaStatusEmbed,
  buildActivityStatusEmbed,
  buildLoaRequestEmbed,
  buildLoaDecisionDmEmbed,
  buildLoaLogEmbed,
  buildLoaListEmbed,
  buildAutoStrikeDmEmbed,
  buildRosterDigestEmbed,
  // ── Exported for tests ──
  parseEvidence,
  banEndShort,
  humanizeMs,
};
