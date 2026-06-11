const { EmbedBuilder } = require('discord.js');
const { normalizeBanId } = require('./sheets');

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
function buildTicketOpenEmbed(type, ownerMention, prompt, submitted = false) {
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
    )
    .setFooter(brandFooter(`${TICKET_BRAND} • Use the buttons below to manage this ticket`))
    .setTimestamp();
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

// ── /help ───────────────────────────────────────────────────────────────────────
function buildHelpEmbed({ isStaff }) {
  const embed = new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setAuthor(brandAuthor(`❓ ${BRAND_NAME} · Help`))
    .setTitle('How can we help?')
    .setDescription(
      'Use the **ticket panel** to open a private channel with our team — pick the category ' +
      'that fits your request (support, reports, applications, and more).',
    )
    .addFields({
      name: '🎫 Opening a ticket',
      value: 'Click a button on the ticket panel. You can have **one open ticket at a time**. ' +
        'For whitelist applications, post your details and press **Submit for Review**.',
      inline: false,
    });

  if (isStaff) {
    embed.addFields(
      {
        name: '🛠️ Ticket commands (staff)',
        value: [
          '`/ticket-panel` — post the ticket panel (admin)',
          '`/claim` · `/unclaim` — claim or release a ticket',
          '`/add` · `/remove` — manage who can see a ticket',
          '`/rename` — rename a ticket channel',
          '`/close` — archive + close a ticket',
        ].join('\n'),
        inline: false,
      },
      {
        name: '📝 Whitelist (staff)',
        value: '`/wl-accept <user>` — approve an applicant and grant the member role',
        inline: false,
      },
      {
        name: '🔨 Moderation logging (staff)',
        value: [
          '`/log-ban` · `/lookup-ban` · `/update-appeal`',
          '`/log-war` · `/lookup-war`',
        ].join('\n'),
        inline: false,
      },
      { name: '🩺 Utility', value: '`/help` · `/ping`', inline: false },
    );
  }

  embed.setFooter(brandFooter(BRAND_NAME)).setTimestamp();
  return embed;
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
  buildHelpEmbed,
  buildStatusEmbed,
};
