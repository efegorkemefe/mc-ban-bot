require('dotenv').config();

const {
  Client, GatewayIntentBits, Events, Collection, PermissionFlagsBits, AttachmentBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
} = require('discord.js');

const sheets = require('./sheets');
const tickets = require('./tickets');
const ai = require('./ai');
const banState = require('./banState');
const stats = require('./stats');
const warnings = require('./warnings');
const notes = require('./notes');
const flags = require('./flags');
const mojang = require('./mojang');
const report = require('./report');
const { computeBanEnd, parseDurationMs } = require('./duration');
const {
  buildBanEmbed,
  buildWarEmbed,
  buildAppealUpdateEmbed,
  buildBanLookupEmbed,
  buildWarLookupEmbed,
  buildConfirmEmbed,
  buildTicketClaimEmbed,
  buildTicketUnclaimEmbed,
  buildTicketNoticeEmbed,
  buildWhitelistReviewEmbed,
  buildMemberPanel,
  buildStaffPanel,
  buildStatusEmbed,
  buildBanListEmbed,
  buildUnbanEmbed,
  buildStatsEmbed,
  buildHistoryEmbed,
  buildMyBansEmbed,
  banListLine,
  historyLine,
  myBanLine,
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
} = require('./embeds');

// ── Config ──────────────────────────────────────────────────────────────────
const BAN_LOG_CHANNEL_ID = process.env.BAN_LOG_CHANNEL_ID;
const WAR_LOG_CHANNEL_ID = process.env.WAR_LOG_CHANNEL_ID;
// Optional separate channel to archive ban evidence in. Falls back to the ban
// log channel. Evidence is re-hosted here so the stored link never expires.
const EVIDENCE_ARCHIVE_CHANNEL_ID = process.env.EVIDENCE_ARCHIVE_CHANNEL_ID || BAN_LOG_CHANNEL_ID;
const SENIOR_ROLE_IDS = (process.env.SENIOR_ROLE_IDS || '')
  .split(',')
  .map(id => id.trim())
  .filter(Boolean);

// Severities that trigger a senior-staff ping.
const PING_SEVERITIES = new Set(['HIGH', 'CRITICAL', 'PERMANENT']);
const EVIDENCE_WINDOW_MS = 2 * 60 * 1000;

// Ticket inactivity auto-close (hours). 0 / unset disables the feature entirely.
const INACTIVITY_CLOSE_HOURS = parseFloat(process.env.TICKET_INACTIVITY_HOURS || '0');
const INACTIVITY_WARN_HOURS = parseFloat(process.env.TICKET_INACTIVITY_WARN_HOURS || '0');
const INACTIVITY_SWEEP_MS = 30 * 60 * 1000; // scan every 30 minutes

// ── Moderation / alt-detection config ─────────────────────────────────────────
// Warnings at/above this count trigger a "consider a ban" hint to staff.
const WARN_BAN_THRESHOLD = parseInt(process.env.WARN_BAN_THRESHOLD || '3', 10);
// Discord accounts younger than this (days) are flagged when opening a whitelist.
const MIN_ACCOUNT_AGE_DAYS = parseInt(process.env.MIN_ACCOUNT_AGE_DAYS || '30', 10);
// A whitelist applicant is flagged if a ban ended/was lifted within this window.
const REJOIN_WINDOW_DAYS = parseInt(process.env.REJOIN_WINDOW_DAYS || '14', 10);
// Hours an unhandled ban appeal can sit before a reminder is posted (0 disables).
const APPEAL_REMINDER_HOURS = parseFloat(process.env.APPEAL_REMINDER_HOURS || '48');
const APPEAL_REMINDER_SWEEP_MS = 12 * 60 * 60 * 1000; // every 12 hours
const WEEKLY_REPORT_SWEEP_MS = 30 * 60 * 1000;        // check every 30 minutes
const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;      // Discord timeout ceiling (28d)

// ── Client ────────────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// In-memory evidence collection, keyed by userId. 2-minute expiry.
const pendingEvidence = new Collection();

// ── Paginated embed replies ─────────────────────────────────────────────────────
// Holds an ordered list of pre-built embeds keyed by a short token; prev/next
// buttons flip between them. Sessions expire after 10 minutes.
const paginators = new Collection();
const PAGINATOR_TTL_MS = 10 * 60 * 1000;

function paginatorComponents(token, page, total) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`pg:${token}:prev`).setEmoji('◀').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId('pg:noop:x').setLabel(`${page + 1} / ${total}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setCustomId(`pg:${token}:next`).setEmoji('▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= total - 1),
  )];
}

// Sends an ephemeral reply that pages through `embeds`. Falls back to a plain
// reply when there's only one page.
async function replyPaginated(interaction, embeds, content) {
  if (embeds.length <= 1) {
    return interaction.editReply({ content, embeds });
  }
  const token = Math.random().toString(36).slice(2, 10);
  const timeout = setTimeout(() => paginators.delete(token), PAGINATOR_TTL_MS);
  paginators.set(token, { embeds, page: 0, content, timeout });
  return interaction.editReply({ content, embeds: [embeds[0]], components: paginatorComponents(token, 0, embeds.length) });
}

async function handlePaginatorButton(interaction) {
  const [, token, dir] = interaction.customId.split(':');
  const session = paginators.get(token);
  if (!session) {
    return interaction.update({ content: '⏳ This list has expired — run the command again.', embeds: [], components: [] }).catch(() => {});
  }
  session.page = dir === 'next'
    ? Math.min(session.embeds.length - 1, session.page + 1)
    : Math.max(0, session.page - 1);
  return interaction.update({
    content: session.content,
    embeds: [session.embeds[session.page]],
    components: paginatorComponents(token, session.page, session.embeds.length),
  });
}

// ── /leaderboard This Week ↔ All Time toggle ─────────────────────────────────
// Caches the parsed ban list per session so the toggle re-renders without re-
// hitting the sheet. Sessions expire after 10 minutes.
const leaderboards = new Collection();

function leaderboardComponents(token, scope) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`lb:${token}:all`).setLabel('All Time').setEmoji('🏆').setStyle(ButtonStyle.Secondary).setDisabled(scope === 'all'),
    new ButtonBuilder().setCustomId(`lb:${token}:week`).setLabel('This Week').setEmoji('📅').setStyle(ButtonStyle.Secondary).setDisabled(scope === 'week'),
  )];
}

function renderLeaderboard(bans, scope) {
  const sinceMs = scope === 'week' ? report.startOfWeek().getTime() : null;
  const entries = report.banLeaderboard(bans, { sinceMs });
  const total = entries.reduce((sum, [, n]) => sum + n, 0);
  return { entries, total };
}

async function handleLeaderboardButton(interaction) {
  const [, token, scope] = interaction.customId.split(':');
  const session = leaderboards.get(token);
  if (!session) {
    return interaction.update({ content: '⏳ This leaderboard expired — run `/leaderboard` again.', embeds: [], components: [] }).catch(() => {});
  }
  const { entries, total } = renderLeaderboard(session.bans, scope);
  return interaction.update({
    embeds: [buildLeaderboardEmbed({ entries, scope, total })],
    components: leaderboardComponents(token, scope),
  });
}

function today() {
  return new Date().toISOString().split('T')[0]; // YYYY-MM-DD
}

client.once(Events.ClientReady, async c => {
  console.log(`✅ Logged in as ${c.user.tag}`);
  console.log('🔧 Build: permission-aware ticket handlers active (deferred + Manage Roles checks).');

  // Presence / activity status.
  try {
    c.user.setPresence({
      activities: [{ name: 'tickets & applications | /help', type: 3 /* Watching */ }],
      status: 'online',
    });
  } catch { /* non-fatal */ }

  // Warm each guild's channel cache so duplicate-ticket detection
  // (tickets.findAnyOpenTicketByUser / countOpenTickets) sees every channel
  // right after boot. Gateway events keep the cache fresh afterwards.
  for (const guild of c.guilds.cache.values()) {
    await guild.channels.fetch().catch(() => {});
  }

  // Ticket inactivity auto-close (opt-in via env). Scans on a fixed interval.
  if (INACTIVITY_CLOSE_HOURS > 0) {
    console.log(`🧹 Inactivity auto-close enabled (warn ${INACTIVITY_WARN_HOURS || 'off'}h / close ${INACTIVITY_CLOSE_HOURS}h).`);
    setInterval(() => {
      for (const guild of client.guilds.cache.values()) {
        tickets
          .sweepInactiveTickets(guild, client, { warnHours: INACTIVITY_WARN_HOURS, closeHours: INACTIVITY_CLOSE_HOURS })
          .catch(err => console.error('Inactivity sweep failed:', err));
      }
    }, INACTIVITY_SWEEP_MS);
  }

  // Appeal-deadline reminders (opt-in via APPEAL_REMINDER_HOURS > 0).
  if (APPEAL_REMINDER_HOURS > 0) {
    console.log(`⏰ Appeal reminders enabled (threshold ${APPEAL_REMINDER_HOURS}h, checked every 12h).`);
    const runAppeals = () => {
      for (const guild of client.guilds.cache.values()) {
        checkAppealReminders(guild).catch(err => console.error('Appeal reminder sweep failed:', err));
      }
    };
    setTimeout(runAppeals, 60_000);
    setInterval(runAppeals, APPEAL_REMINDER_SWEEP_MS);
  }

  // Weekly staff activity report (posts on/after Monday 09:00 server time).
  const runWeekly = () => {
    for (const guild of client.guilds.cache.values()) {
      checkWeeklyReport(guild).catch(err => console.error('Weekly report check failed:', err));
    }
  };
  setTimeout(runWeekly, 60_000);
  setInterval(runWeekly, WEEKLY_REPORT_SWEEP_MS);

  await reportStartupConfig(c);
});

// Resolves configured channels/roles on boot and prints a readable report so
// setup problems surface immediately instead of failing silently at runtime.
async function reportStartupConfig(c) {
  const ok = v => (v ? '✅' : '⚠️ ');
  const lines = ['', '──────── Configuration ────────'];

  const banCh = BAN_LOG_CHANNEL_ID && await c.channels.fetch(BAN_LOG_CHANNEL_ID).catch(() => null);
  const warCh = WAR_LOG_CHANNEL_ID && await c.channels.fetch(WAR_LOG_CHANNEL_ID).catch(() => null);
  const logCh = process.env.TICKET_LOG_CHANNEL_ID && await c.channels.fetch(process.env.TICKET_LOG_CHANNEL_ID).catch(() => null);

  lines.push(`${ok(banCh)} Ban log channel        ${banCh ? `#${banCh.name}` : 'not set / unreachable'}`);
  lines.push(`${ok(warCh)} War log channel        ${warCh ? `#${warCh.name}` : 'not set / unreachable'}`);
  lines.push(`${ok(logCh)} Ticket transcript log  ${logCh ? `#${logCh.name}` : 'not set (transcripts won\'t be archived)'}`);
  lines.push(`${ok(process.env.STAFF_ROLE_IDS)} Staff role(s)          ${process.env.STAFF_ROLE_IDS || 'none (falls back to Manage Server)'}`);
  lines.push(`${ok(SENIOR_ROLE_IDS.length)} Senior role(s)         ${SENIOR_ROLE_IDS.join(', ') || 'none'}`);
  lines.push(`${ok(process.env.MEMBER_ROLE_ID)} Member role            ${process.env.MEMBER_ROLE_ID || 'not set (whitelist approval will fail)'}`);
  lines.push(`${ok(ai.isEnabled())} AI whitelist review    ${ai.isEnabled() ? 'enabled (Claude)' : 'manual review (no API key)'}`);

  // Verify the bot has the permissions the ticket system needs.
  for (const guild of c.guilds.cache.values()) {
    const me = guild.members.me;
    if (!me) continue;
    const missing = ['ManageChannels', 'ManageRoles', 'ModerateMembers', 'ManageNicknames']
      .filter(p => !me.permissions.has(PermissionFlagsBits[p]));
    if (missing.length) {
      lines.push(`⚠️  Missing permission(s) in "${guild.name}": ${missing.join(', ')} — some features may not work (Moderate Members → /mute, Manage Nicknames → whitelist rename).`);
    }
  }

  lines.push('───────────────────────────────', '');
  console.log(lines.join('\n'));
}

// ── Interaction router ────────────────────────────────────────────────────────
client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isButton()) {
      if (interaction.customId.startsWith('ticket:')) return await handleTicketButton(interaction);
      if (interaction.customId.startsWith('pg:')) return await handlePaginatorButton(interaction);
      if (interaction.customId.startsWith('lb:')) return await handleLeaderboardButton(interaction);
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    switch (interaction.commandName) {
      case 'log-ban':       return await handleLogBan(interaction);
      case 'update-appeal': return await handleUpdateAppeal(interaction);
      case 'lookup-ban':    return await handleLookupBan(interaction);
      case 'findban':       return await handleFindBan(interaction);
      case 'banlist':       return await handleBanList(interaction);
      case 'unban':         return await handleUnban(interaction);
      case 'stats':         return await handleStats(interaction);
      case 'history':       return await handleHistory(interaction);
      case 'log-war':       return await handleLogWar(interaction);
      case 'lookup-war':    return await handleLookupWar(interaction);
      // ── Moderation / utility ──
      case 'mute':          return await handleMute(interaction);
      case 'warn':          return await handleWarn(interaction);
      case 'warnings':      return await handleWarnings(interaction);
      case 'note':          return await handleNote(interaction);
      case 'notes':         return await handleNotes(interaction);
      case 'flags':         return await handleFlags(interaction);
      case 'resolve-flag':  return await handleResolveFlag(interaction);
      case 'leaderboard':   return await handleLeaderboard(interaction);
      case 'priority':      return await handlePriority(interaction);
      // ── Ticket commands ──
      case 'ticket-panel':  return await handleTicketPanel(interaction);
      case 'add':           return await handleTicketAdd(interaction);
      case 'remove':        return await handleTicketRemove(interaction);
      case 'claim':         return await handleTicketClaim(interaction);
      case 'unclaim':       return await handleTicketUnclaim(interaction);
      case 'rename':        return await handleTicketRename(interaction);
      case 'close':         return await handleTicketClose(interaction);
      case 'wl-accept':     return await handleWlAccept(interaction);
      case 'help':          return await handleHelp(interaction);
      case 'info-panel':    return await handleInfoPanel(interaction);
      case 'staff-panel':   return await handleStaffPanel(interaction);
      case 'ping':          return await handlePing(interaction);
    }
  } catch (err) {
    console.error(`Error handling interaction (${interaction.commandName || interaction.customId}):`, err);
    let msg = '❌ Something went wrong. Check the bot logs.';
    if (err?.code === 'TIMEOUT') {
      msg = '⏳ Discord is responding slowly or rate-limiting this channel right now — please try again in a moment.';
    } else if (err?.code === 50013) {
      msg = '❌ I\'m missing the **Manage Roles** permission needed for that action. Enable it for my role and move my role above the ticket/member roles.';
    } else if (err?.code === 50001) {
      msg = '❌ I don\'t have access to that channel.';
    }
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(msg).catch(() => {});
    } else {
      await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
    }
  }
});

// ── Ticket helpers ──────────────────────────────────────────────────────────
// Resolves the current channel as a ticket, or replies with an error and returns
// null. Used by every in-ticket command.
async function requireTicket(interaction) {
  const meta = tickets.decodeTopic(interaction.channel?.topic);
  if (!meta) {
    await interaction.reply({ content: '❌ This command can only be used inside a ticket channel.', ephemeral: true });
    return null;
  }
  return meta;
}

function requireStaff(interaction) {
  if (tickets.isStaff(interaction.member)) return true;
  interaction.reply({ content: '❌ Only staff can use this command.', ephemeral: true }).catch(() => {});
  return false;
}

// True if the bot is missing a guild permission it needs for the action.
function botLacks(interaction, permName) {
  const me = interaction.guild?.members?.me;
  return !!me && !me.permissions.has(PermissionFlagsBits[permName]);
}

// Fast, actionable guard: replies immediately if the bot can't manage permissions,
// instead of letting the Discord API call stall (the "stuck on thinking" symptom).
async function ensureBotCanManageRoles(interaction) {
  if (!botLacks(interaction, 'ManageRoles')) return true;
  await interaction.reply({
    content:
      '❌ I can\'t do that — I\'m missing the **Manage Roles** permission.\n' +
      'Ask an admin to: **Server Settings → Roles → my role → enable Manage Roles**, ' +
      'and drag my role **above** the ticket/member roles. (Creating tickets only needs ' +
      'Manage Channels, but adding/claiming edits channel permissions, which needs Manage Roles.)',
    ephemeral: true,
  }).catch(() => {});
  return false;
}

// Races a promise against a timeout so a slow/rate-limited Discord call can never
// leave a command stuck on "thinking…" — it rejects with a TIMEOUT error instead,
// which the interaction handler turns into a friendly "try again" message.
function withTimeout(promise, ms = 9000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('Operation timed out'), { code: 'TIMEOUT' })), ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

// ── Ticket buttons ────────────────────────────────────────────────────────────
async function handleTicketButton(interaction) {
  const id = interaction.customId;

  // Panel → open a new ticket.
  if (id.startsWith('ticket:open:')) {
    const typeKey = id.slice('ticket:open:'.length);
    await interaction.deferReply({ ephemeral: true });
    const res = await tickets.createTicket(interaction.guild, interaction.member, typeKey);
    if (!res.ok) return interaction.editReply(res.message);
    const label = tickets.TICKET_TYPES[typeKey]?.label || 'ticket';
    await interaction.editReply(`✅ Your **${label}** ticket has been created: <#${res.channel.id}>`);
    // Whitelist tickets get alt-detection flags posted in-channel (non-blocking).
    if (typeKey === 'whitelist') {
      runWhitelistOpenChecks(res.channel, interaction.user)
        .catch(err => console.error('Whitelist open checks failed:', err));
    }
    return;
  }

  // Everything else acts on the current ticket channel.
  const meta = tickets.decodeTopic(interaction.channel?.topic);
  if (!meta) {
    return interaction.reply({ content: '❌ This is not a ticket channel.', ephemeral: true });
  }

  if (id === 'ticket:claim') {
    if (!tickets.isStaff(interaction.member)) {
      return interaction.reply({ content: '❌ Only staff can claim tickets.', ephemeral: true });
    }
    if (!(await ensureBotCanManageRoles(interaction))) return;
    await interaction.deferReply(); // claiming does several permission edits
    const res = await withTimeout(tickets.claimTicket(interaction.channel, interaction.user.id));
    if (!res.ok) return interaction.editReply(`❌ ${res.message}`);
    await interaction.message.edit({ components: tickets.ticketControlComponents(true, meta.type) }).catch(() => {});
    return interaction.editReply({ embeds: [buildTicketClaimEmbed(`<@${interaction.user.id}>`)] });
  }

  if (id === 'ticket:wlsubmit') {
    return await handleWhitelistSubmit(interaction, meta);
  }

  if (id === 'ticket:wlappeal') {
    return await handleWhitelistAppeal(interaction, meta);
  }

  if (id === 'ticket:lookupban') {
    return await handleBanAppealLookup(interaction, meta);
  }

  if (id === 'ticket:close') {
    const canClose = tickets.isStaff(interaction.member) || interaction.user.id === meta.ownerId;
    if (!canClose) {
      return interaction.reply({ content: '❌ Only staff or the ticket owner can close this ticket.', ephemeral: true });
    }
    return interaction.reply({
      content: '⚠️ Are you sure you want to close this ticket? A transcript will be saved and the channel deleted.',
      components: tickets.closeConfirmComponents(),
      ephemeral: true,
    });
  }

  if (id === 'ticket:closeConfirm') {
    const canClose = tickets.isStaff(interaction.member) || interaction.user.id === meta.ownerId;
    if (!canClose) return interaction.update({ content: '❌ You cannot close this ticket.', components: [] });
    await interaction.update({ content: '🔒 Closing ticket…', components: [] });
    return tickets.closeTicket(interaction.channel, interaction.member, null, client);
  }

  if (id === 'ticket:closeCancel') {
    return interaction.update({ content: '✅ Close cancelled.', components: [] });
  }
}

// ── Whitelist open checks (account age + ban-rejoin timing) ─────────────────────
// Runs after a whitelist ticket is created. Records the applicant for join-timing
// detection and posts staff-pinged flags into the ticket when something looks off.
// Flags are advisory — they never block the application.
async function runWhitelistOpenChecks(channel, user) {
  const staffRoleIds = tickets.staffPingRoleIds();
  const pingContent = staffRoleIds.map(r => `<@&${r}>`).join(' ') || undefined;

  flags.recordApplicant({
    discordId: user.id,
    accountCreatedAt: new Date(user.createdTimestamp).toISOString(),
    ticketOpenedAt: new Date().toISOString(),
  });

  // 1) New Discord account.
  const ageDays = Math.floor((Date.now() - user.createdTimestamp) / 86_400_000);
  if (ageDays < MIN_ACCOUNT_AGE_DAYS) {
    const flag = flags.addFlag({
      discordId: user.id,
      type: 'account_age',
      reason: `Discord account only ${ageDays} day(s) old (threshold ${MIN_ACCOUNT_AGE_DAYS}).`,
    });
    await channel.send({
      content: pingContent,
      embeds: [buildAccountAgeFlagEmbed({ userMention: `<@${user.id}>`, ageDays, minDays: MIN_ACCOUNT_AGE_DAYS, flagId: flag.id })],
      allowedMentions: { roles: staffRoleIds },
    }).catch(() => {});
  }

  // 2) Ban-rejoin timing: any ban that ended or was lifted within the window.
  try {
    const rows = await withTimeout(sheets.getBanRecords());
    const now = Date.now();
    const windowMs = REJOIN_WINDOW_DAYS * 86_400_000;
    const recent = [];
    for (const b of rows.map(sheets.rowToBan)) {
      if (!sheets.normalizeBanId(b.ban_id)) continue;
      const unban = banState.getUnban(b.ban_id);
      if (unban?.at) {
        const t = Date.parse(unban.at);
        if (!Number.isNaN(t) && t <= now && now - t <= windowMs) { recent.push({ ban: b, when: t, how: 'lifted' }); continue; }
      }
      const info = computeBanEnd(b.date, b.duration);
      if (info.state === 'ended' && info.endMs && info.endMs <= now && now - info.endMs <= windowMs) {
        recent.push({ ban: b, when: info.endMs, how: 'expired' });
      }
    }
    if (recent.length) {
      recent.sort((a, b) => b.when - a.when);
      const flag = flags.addFlag({
        discordId: user.id,
        type: 'rejoin_timing',
        reason: `Applied within ${REJOIN_WINDOW_DAYS}d of ${recent.length} ban(s) ending/being lifted (e.g. ${recent[0].ban.player_banned || 'unknown'}).`,
      });
      await channel.send({
        content: pingContent,
        embeds: [buildRejoinFlagEmbed({ userMention: `<@${user.id}>`, recent, flagId: flag.id })],
        allowedMentions: { roles: staffRoleIds },
      }).catch(() => {});
    }
  } catch (err) {
    console.warn('Rejoin-timing check skipped:', err.message);
  }
}

// ── Whitelist: Submit for Review (AI decision) ──────────────────────────────────
async function handleWhitelistSubmit(interaction, meta) {
  if (meta.type !== 'whitelist') {
    return interaction.reply({ content: '❌ This button only works in a whitelist application.', ephemeral: true });
  }
  const isOwner = interaction.user.id === meta.ownerId;
  if (!isOwner && !tickets.isStaff(interaction.member)) {
    return interaction.reply({ content: '❌ Only the applicant can submit this application.', ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });

  const appText = await tickets.collectApplicationText(interaction.channel, meta.ownerId);
  if (!appText || appText.trim().length < 15) {
    return interaction.editReply(
      '⚠️ Please type your application in this channel first — your Minecraft username, age, whether you own an ' +
      'original copy of Minecraft, and why you want to join — then click **Submit for Review** again.',
    );
  }

  // ── Verify the Minecraft IGN against Mojang ──
  // A confirmed 404 (no such username) blocks submission; API/network errors do
  // not (we proceed unverified rather than punish the applicant for a Mojang outage).
  let verified = null;
  const candidateIgn = mojang.extractIgn(appText);
  if (candidateIgn) {
    const v = await mojang.verifyIgn(candidateIgn).catch(() => ({ ok: false, status: 0 }));
    if (!v.ok && v.status === 404) {
      return interaction.editReply(
        `⚠️ I couldn't find a Minecraft account named **${candidateIgn}**. ` +
        'Please double-check the spelling, type your correct **in-game name** in this channel, ' +
        'and click **📨 Submit for Review** again.',
      );
    }
    if (v.ok) {
      verified = { ign: v.name, uuid: v.uuid };
      sheets.recordVerifiedPlayer({ discordId: meta.ownerId, discordTag: interaction.user.tag, ign: v.name, uuid: v.uuid })
        .catch(err => console.warn('Verified-players sheet write failed:', err.message));
      flags.backfillIgn(meta.ownerId, v.name);
      flags.updateApplicantIgn(meta.ownerId, v.name, v.uuid);
    }
  }

  const aiEnabled = ai.isEnabled();
  const review = aiEnabled ? await ai.reviewWhitelist(appText) : { ok: false };
  const ownerMention = `<@${meta.ownerId}>`;

  // No AI (manual mode) or AI error → route to staff for a human decision.
  if (!review.ok) {
    const roleIds = tickets.staffPingRoleIds();
    await interaction.channel.send({
      content: roleIds.map(r => `<@&${r}>`).join(' ') || undefined,
      embeds: [buildTicketNoticeEmbed({
        title: aiEnabled ? 'Manual Review Needed' : 'Application Submitted',
        description: aiEnabled
          ? `Automated review is unavailable right now, so a staff member will review ${ownerMention}'s application above.`
          : `Thanks ${ownerMention}! Your application has been submitted and our staff team will review it shortly.`,
        color: aiEnabled ? 0xf0a500 : 0x57c454,
        emoji: aiEnabled ? '🛠️' : '📨',
      })],
      allowedMentions: { roles: roleIds },
    });
    await interaction.message.edit({ components: tickets.closedControlComponents() }).catch(() => {});
    return interaction.editReply(aiEnabled
      ? '⚠️ Automated review is unavailable right now — our staff have been notified and will review your application manually.'
      : '✅ Your application has been submitted — our staff team will review it shortly!');
  }

  const approved = review.decision === 'approve';
  await interaction.channel.send({
    embeds: [buildWhitelistReviewEmbed({
      approved,
      confidence: review.confidence,
      summary: review.summary,
      reasons: review.reasons,
      ownerMention,
    })],
  });

  if (approved) {
    const roleRes = await tickets.grantWhitelist(interaction.guild, meta.ownerId, { ign: verified?.ign });
    await interaction.message.edit({ components: tickets.closedControlComponents() }).catch(() => {});

    if (!roleRes.ok) {
      const roleIds = tickets.staffPingRoleIds();
      await interaction.channel.send({
        content: roleIds.map(r => `<@&${r}>`).join(' ') || undefined,
        embeds: [buildTicketNoticeEmbed({
          title: 'Role Assignment Failed',
          description: `The application was approved, but I couldn't assign the member role automatically (\`${roleRes.error}\`). A staff member can run \`/wl-accept\` for ${ownerMention}.`,
          color: 0xf0a500,
          emoji: '⚠️',
        })],
        allowedMentions: { roles: roleIds },
      });
      return interaction.editReply('✅ Your application was approved, but I could not assign your role automatically — staff have been notified.');
    }

    // Approved + role granted → auto-archive shortly.
    setTimeout(() => {
      tickets.closeTicket(interaction.channel, { id: client.user.id }, 'Whitelist approved automatically', client).catch(() => {});
    }, 10_000);
    return interaction.editReply(
      '✅ Your application was approved and you now have the member role!' +
      (roleRes.nickname ? ` Your nickname has been set to **${roleRes.nickname}**.` : '') +
      ' This ticket will close shortly.',
    );
  }

  // Rejected → offer an appeal.
  await interaction.message.edit({ components: tickets.appealComponents() }).catch(() => {});
  return interaction.editReply('⛔ Your application was not approved. You can appeal using the **Appeal Decision** button and a staff member will review it.');
}

// ── Whitelist: Appeal (escalate to staff) ───────────────────────────────────────
async function handleWhitelistAppeal(interaction, meta) {
  if (interaction.user.id !== meta.ownerId && !tickets.isStaff(interaction.member)) {
    return interaction.reply({ content: '❌ Only the applicant can appeal this decision.', ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });
  const roleIds = tickets.staffPingRoleIds();
  await interaction.message.edit({ components: tickets.closedControlComponents() }).catch(() => {});
  await interaction.channel.send({
    content: roleIds.map(r => `<@&${r}>`).join(' ') || undefined,
    embeds: [buildTicketNoticeEmbed({
      title: 'Appeal Submitted',
      description: `<@${meta.ownerId}> has appealed the automated decision. A staff member will review this application manually and can approve it with \`/wl-accept\`.`,
      color: 0xf0a500,
      emoji: '📣',
    })],
    allowedMentions: { roles: roleIds },
  });
  return interaction.editReply('📣 Your appeal has been submitted — staff have been notified and will review your application.');
}

// ── Ban Appeal: Look Up Ban (attach the record + notify staff) ──────────────────
// Pulls a ban-ID-looking token out of the applicant's messages, prefering an
// explicit "Ban ID: NNN" over a loose number so ages/years aren't mistaken for it.
function extractBanId(text) {
  if (!text) return null;
  const patterns = [/ban\s*id:?\s*(\d{1,5})/i, /\bid:?\s*(\d{1,5})/i, /#?\b(\d{1,5})\b/];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) return m[1];
  }
  return null;
}

async function handleBanAppealLookup(interaction, meta) {
  if (meta.type !== 'ban_appeal') {
    return interaction.reply({ content: '❌ This button only works in a ban appeal ticket.', ephemeral: true });
  }
  if (interaction.user.id !== meta.ownerId && !tickets.isStaff(interaction.member)) {
    return interaction.reply({ content: '❌ Only the person appealing can look up their ban.', ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });

  const text = await tickets.collectApplicationText(interaction.channel, meta.ownerId);
  const banId = extractBanId(text);
  if (!banId) {
    return interaction.editReply('⚠️ Please type the **Ban ID** you are appealing (e.g. `004`) in this channel first, then click **Look Up Ban** again.');
  }

  const found = await withTimeout(sheets.findBanById(banId)).catch(() => null);
  if (!found) {
    return interaction.editReply(`❌ I couldn't find a ban with ID \`${banId}\`. Double-check the ID and try again.`);
  }

  const ban = sheets.rowToBan(found.rowData);
  const unban = banState.getUnban(ban.ban_id);
  const roleIds = tickets.staffPingRoleIds();

  await interaction.channel.send({
    content: roleIds.map(r => `<@&${r}>`).join(' ') || undefined,
    embeds: [buildBanLookupEmbed(ban, { unban })],
    allowedMentions: { roles: roleIds },
  });

  if (String(ban.appeal_status).toLowerCase().includes('unappeal')) {
    await interaction.channel.send({
      embeds: [buildTicketNoticeEmbed({
        title: 'Heads up — marked Unappealable',
        description: `Ban \`ID: ${sheets.normalizeBanId(ban.ban_id)}\` was logged as **Unappealable**. Staff can still review, but approval is unlikely.`,
        color: 0xf0a500,
        emoji: '⚠️',
      })],
    });
  }

  return interaction.editReply('✅ Your ban record has been posted above and staff have been notified.');
}

// ── /wl-accept ──────────────────────────────────────────────────────────────────
async function handleWlAccept(interaction) {
  if (!tickets.isStaff(interaction.member)) {
    return interaction.reply({ content: '❌ Only staff can use this command.', ephemeral: true });
  }
  if (!(await ensureBotCanManageRoles(interaction))) return;
  const user = interaction.options.getUser('user');
  await interaction.deferReply();

  // If we verified this user's IGN earlier, set their nickname to it on approval.
  const storedIgn = flags.getApplicantIgn(user.id);
  const res = await withTimeout(tickets.grantWhitelist(interaction.guild, user.id, { ign: storedIgn }));
  if (!res.ok) {
    return interaction.editReply(`❌ Could not assign the member role to <@${user.id}>: \`${res.error}\`\n(Make sure my role is **above** the member role and I have **Manage Roles**.)`);
  }
  return interaction.editReply({
    embeds: [buildTicketNoticeEmbed({
      title: 'Whitelist Accepted',
      description: `<@${user.id}> has been given the member role by <@${interaction.user.id}>.` +
        (res.nickname ? ` Nickname set to **${res.nickname}**.` : '') + ' Welcome aboard! 🎉',
      color: 0x57c454,
      emoji: '✅',
    })],
  });
}

// ── /ticket-panel ──────────────────────────────────────────────────────────────
async function handleTicketPanel(interaction) {
  if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    return interaction.reply({ content: '❌ You need the **Manage Server** permission to post the ticket panel.', ephemeral: true });
  }
  await interaction.deferReply({ ephemeral: true });
  await tickets.postPanel(interaction.guild, interaction.channel);
  return interaction.editReply('✅ Ticket panel posted and ticket categories are ready.');
}

// ── /add ────────────────────────────────────────────────────────────────────────
async function handleTicketAdd(interaction) {
  if (!(await requireTicket(interaction))) return;
  if (!requireStaff(interaction)) return;
  if (!(await ensureBotCanManageRoles(interaction))) return;

  await interaction.deferReply();
  const user = interaction.options.getUser('user');
  await withTimeout(tickets.addUserToTicket(interaction.channel, user.id));
  return interaction.editReply({
    embeds: [buildTicketNoticeEmbed({
      title: 'User Added',
      description: `<@${user.id}> has been added to this ticket by <@${interaction.user.id}>.`,
      color: 0x57c454,
      emoji: '➕',
    })],
  });
}

// ── /remove ──────────────────────────────────────────────────────────────────────
async function handleTicketRemove(interaction) {
  const meta = await requireTicket(interaction);
  if (!meta) return;
  if (!requireStaff(interaction)) return;

  const user = interaction.options.getUser('user');
  if (user.id === meta.ownerId) {
    return interaction.reply({ content: '❌ You cannot remove the ticket owner. Close the ticket instead.', ephemeral: true });
  }
  if (!(await ensureBotCanManageRoles(interaction))) return;
  await interaction.deferReply();
  await withTimeout(tickets.removeUserFromTicket(interaction.channel, user.id));
  return interaction.editReply({
    embeds: [buildTicketNoticeEmbed({
      title: 'User Removed',
      description: `<@${user.id}> has been removed from this ticket by <@${interaction.user.id}>.`,
      color: 0xe84343,
      emoji: '➖',
    })],
  });
}

// ── /claim ────────────────────────────────────────────────────────────────────────
async function handleTicketClaim(interaction) {
  if (!(await requireTicket(interaction))) return;
  if (!requireStaff(interaction)) return;
  if (!(await ensureBotCanManageRoles(interaction))) return;

  await interaction.deferReply();
  const res = await withTimeout(tickets.claimTicket(interaction.channel, interaction.user.id));
  if (!res.ok) return interaction.editReply(`❌ ${res.message}`);
  return interaction.editReply({ embeds: [buildTicketClaimEmbed(`<@${interaction.user.id}>`)] });
}

// ── /unclaim ──────────────────────────────────────────────────────────────────────
async function handleTicketUnclaim(interaction) {
  const meta = await requireTicket(interaction);
  if (!meta) return;
  if (!requireStaff(interaction)) return;

  // Only the claimer or a senior staff member can release a claim.
  const claimedBy = tickets.getClaimedBy(interaction.channel);
  if (claimedBy && claimedBy !== interaction.user.id && !tickets.isSenior(interaction.member)) {
    return interaction.reply({ content: `❌ Only <@${claimedBy}> or senior staff can release this ticket.`, ephemeral: true });
  }
  if (!(await ensureBotCanManageRoles(interaction))) return;

  await interaction.deferReply();
  const res = await withTimeout(tickets.unclaimTicket(interaction.channel));
  if (!res.ok) return interaction.editReply(`❌ ${res.message}`);
  return interaction.editReply({ embeds: [buildTicketUnclaimEmbed(`<@${interaction.user.id}>`)] });
}

// ── /rename ──────────────────────────────────────────────────────────────────────
async function handleTicketRename(interaction) {
  if (!(await requireTicket(interaction))) return;
  if (!requireStaff(interaction)) return;
  if (botLacks(interaction, 'ManageChannels')) {
    return interaction.reply({ content: '❌ I\'m missing the **Manage Channels** permission needed to rename channels.', ephemeral: true });
  }

  const raw = interaction.options.getString('name');
  const name = raw.toLowerCase().replace(/[^a-z0-9\- ]/g, '').replace(/\s+/g, '-').slice(0, 90) || 'ticket';
  await interaction.deferReply();
  await interaction.channel.setName(name);
  return interaction.editReply({
    embeds: [buildTicketNoticeEmbed({
      title: 'Ticket Renamed',
      description: `This ticket was renamed to \`${name}\` by <@${interaction.user.id}>.`,
      color: 0x5865f2,
      emoji: '✏️',
    })],
  });
}

// ── /close ────────────────────────────────────────────────────────────────────────
async function handleTicketClose(interaction) {
  const meta = await requireTicket(interaction);
  if (!meta) return;

  const canClose = tickets.isStaff(interaction.member) || interaction.user.id === meta.ownerId;
  if (!canClose) {
    return interaction.reply({ content: '❌ Only staff or the ticket owner can close this ticket.', ephemeral: true });
  }

  const reason = interaction.options.getString('reason');
  await interaction.reply({ content: '🔒 Closing ticket…', ephemeral: true });
  return tickets.closeTicket(interaction.channel, interaction.member, reason, client);
}

// ── /log-ban ──────────────────────────────────────────────────────────────────
async function handleLogBan(interaction) {
  const banData = {
    player_banned: interaction.options.getString('player_banned'),
    offense:       interaction.options.getString('offense'),
    severity:      interaction.options.getString('severity'),
    duration:      interaction.options.getString('duration'),
    appeal_status: interaction.options.getString('appeal_status'),
    date:          interaction.options.getString('date') || today(),
    staff_member:  interaction.member?.displayName || interaction.user.username,
    staff_id:      interaction.user.id,
  };

  await interaction.deferReply({ ephemeral: true });

  // Cross-reference: warn staff if this player already has bans on record, so
  // they're informed before submitting. Best-effort — never blocks the ban.
  let priorEmbed = null;
  try {
    const prior = await withTimeout(sheets.findBansByPlayer(banData.player_banned));
    if (prior.length) {
      priorEmbed = buildPriorBansWarningEmbed(banData.player_banned, prior.map(m => sheets.rowToBan(m.rowData)));
    }
  } catch (err) {
    console.warn('Prior-ban cross-reference skipped:', err.message);
  }

  // Replace any existing pending entry for this user.
  const existing = pendingEvidence.get(interaction.user.id);
  if (existing?.timeout) clearTimeout(existing.timeout);

  // On timeout, finalize with whatever was collected (so nothing is lost).
  const timeout = setTimeout(() => {
    finalizeBan(interaction.user.id, { reason: 'timeout' }).catch(err =>
      console.error('Timeout finalize failed:', err),
    );
  }, EVIDENCE_WINDOW_MS);

  pendingEvidence.set(interaction.user.id, {
    banData,
    interaction,
    channelId: interaction.channelId,
    evidenceFiles: [], // { buffer, ext } — downloaded while the CDN URL is fresh
    expiresAt: Date.now() + EVIDENCE_WINDOW_MS,
    timeout,
  });

  await interaction.editReply({
    content:
      `✅ Ban details recorded for **${banData.player_banned}** (ID will be assigned automatically).\n\n` +
      `📎 **Upload your evidence screenshot(s) in this channel within 2 minutes.**\n` +
      `Each upload is auto-removed to keep the channel clean. Type \`done\` when finished ` +
      `(or just wait — I'll log it automatically once the window closes).`,
    embeds: priorEmbed ? [priorEmbed] : [],
  });
}

// Deletes a user message if we have permission; never throws.
async function safeDelete(message) {
  try {
    await message.delete();
  } catch (err) {
    console.warn('Could not delete message (missing Manage Messages?):', err.message);
  }
}

// Downloads an attachment to a Buffer while its (short-lived) CDN URL is still
// valid, so it can be re-hosted permanently later. Returns null on failure.
async function downloadEvidence(attachment) {
  try {
    const res = await fetch(attachment.url);
    if (!res.ok) {
      console.warn('Evidence download failed with HTTP', res.status);
      return null;
    }
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    console.warn('Could not download evidence attachment:', err.message);
    return null;
  }
}

// Derives a safe file extension from an attachment's name or content type.
function evidenceExt(attachment) {
  const m = /\.([a-z0-9]+)$/i.exec(attachment.name || '');
  if (m) return `.${m[1].toLowerCase()}`;
  return `.${(attachment.contentType?.split('/')[1] || 'png')}`;
}

// Writes the ban to the sheet, posts the embed to the log channel, and clears
// the pending state. Called from both the "done"/upload path and the timeout.
async function finalizeBan(userId, { reason } = {}) {
  const pending = pendingEvidence.get(userId);
  if (!pending) return;
  if (pending.timeout) clearTimeout(pending.timeout);
  pendingEvidence.delete(userId);

  const { banData, evidenceFiles, interaction } = pending;

  // Timeout with nothing uploaded → tell the user and bail.
  if (reason === 'timeout' && evidenceFiles.length === 0) {
    await interaction
      .editReply('⏰ Evidence window closed with no screenshots uploaded. Run `/log-ban` again to retry.')
      .catch(() => {});
    return;
  }

  try {
    // Write the row first to assign the ban ID; the permanent evidence link is
    // filled in (column G) after we post the screenshots below.
    const banId = await withTimeout(sheets.appendBan(banData, []), 15000);

    const formatted = { ...banData, ban_id: banId };

    // Re-host the screenshots as message attachments so their links never expire.
    const files = evidenceFiles.map((f, i) => new AttachmentBuilder(f.buffer, { name: `evidence-${i + 1}${f.ext}` }));
    const imageRef = files.length ? `attachment://${files[0].name}` : null;

    const banEmbed = buildBanEmbed(formatted, { imageUrl: imageRef, count: files.length }, `<@${banData.staff_id}>`);

    let evidenceLink = '';
    const channel = await client.channels.fetch(BAN_LOG_CHANNEL_ID).catch(() => null);
    if (!channel) {
      console.error('❌ Could not fetch BAN_LOG_CHANNEL_ID:', BAN_LOG_CHANNEL_ID);
    } else {
      const shouldPing = PING_SEVERITIES.has(String(banData.severity).toUpperCase());
      const content = shouldPing && SENIOR_ROLE_IDS.length
        ? `${SENIOR_ROLE_IDS.map(id => `<@&${id}>`).join(' ')} — **${banData.severity}** severity ban logged.`
        : undefined;
      // Attaching the files to the log message keeps the embed's inline preview permanent.
      const banLogMsg = await channel.send({
        content,
        embeds: [banEmbed],
        files,
        allowedMentions: { roles: SENIOR_ROLE_IDS },
      });

      // Determine the permanent evidence link to store in the sheet. If a
      // dedicated archive channel is configured, re-host there; otherwise link
      // back to the log message itself.
      if (files.length) {
        if (EVIDENCE_ARCHIVE_CHANNEL_ID && EVIDENCE_ARCHIVE_CHANNEL_ID !== BAN_LOG_CHANNEL_ID) {
          const archive = await client.channels.fetch(EVIDENCE_ARCHIVE_CHANNEL_ID).catch(() => null);
          if (archive) {
            const archiveFiles = evidenceFiles.map((f, i) => new AttachmentBuilder(f.buffer, { name: `evidence-${i + 1}${f.ext}` }));
            const archiveMsg = await archive
              .send({ content: `📎 Evidence for ban \`${formatted.ban_id}\` — **${banData.player_banned}**`, files: archiveFiles })
              .catch(err => { console.error('Failed to archive evidence:', err); return null; });
            if (archiveMsg) evidenceLink = archiveMsg.url;
          }
        }
        if (!evidenceLink) evidenceLink = banLogMsg.url;
      }
    }

    // Persist the permanent link (best-effort — the ban itself is already logged).
    if (evidenceLink) {
      await withTimeout(sheets.updateEvidence(formatted.ban_id, evidenceLink), 15000)
        .catch(err => console.error('Failed to store evidence link:', err));
    }

    await interaction
      .editReply(`✅ Ban \`${formatted.ban_id}\` logged with ${evidenceFiles.length} screenshot(s) and posted.`)
      .catch(() => {});
  } catch (err) {
    console.error('Error logging ban:', err);
    await interaction
      .editReply('❌ Something went wrong writing to the sheet. Check the bot logs.')
      .catch(() => {});
  }
}

// ── Evidence collection ─────────────────────────────────────────────────────
// Staff upload screenshots in the same channel they ran /log-ban. Each upload is
// accumulated and auto-deleted to prevent flooding the channel; typing `done`
// finalizes immediately, otherwise the 2-minute timeout finalizes automatically.
client.on(Events.MessageCreate, async message => {
  if (message.author.bot) return;

  const pending = pendingEvidence.get(message.author.id);
  if (!pending) return;
  if (message.channelId !== pending.channelId) return;

  const imageAttachments = [...message.attachments.values()]
    .filter(a => a.contentType?.startsWith('image/'));
  const isDone = message.content.trim().toLowerCase() === 'done';

  if (imageAttachments.length === 0 && !isDone) return; // ignore unrelated chatter

  // Auto-delete the submission to keep the channel clean.
  await safeDelete(message);

  if (imageAttachments.length > 0) {
    // Download now, while the CDN URLs are still valid, so we can re-host them
    // permanently when the ban is finalized.
    for (const att of imageAttachments) {
      const buffer = await downloadEvidence(att);
      if (buffer) pending.evidenceFiles.push({ buffer, ext: evidenceExt(att) });
    }
    await pending.interaction
      .editReply(
        `📎 Collected **${pending.evidenceFiles.length}** screenshot(s). ` +
        `Upload more or type \`done\` to finish.`,
      )
      .catch(() => {});
  }

  if (isDone) {
    if (pending.evidenceFiles.length === 0) {
      await pending.interaction
        .editReply('⚠️ Please upload at least one screenshot before typing `done`.')
        .catch(() => {});
      return;
    }
    await finalizeBan(message.author.id, { reason: 'done' });
  }
});

// ── /update-appeal ────────────────────────────────────────────────────────────
async function handleUpdateAppeal(interaction) {
  const banId = interaction.options.getString('ban_id');
  const status = interaction.options.getString('status');

  await interaction.deferReply({ ephemeral: true });

  const updated = await withTimeout(sheets.updateAppealStatus(banId, status), 15000);
  if (!updated) {
    await interaction.editReply(`❌ Ban \`ID: ${sheets.normalizeBanId(banId)}\` not found in the sheet.`);
    return;
  }

  const embed = buildAppealUpdateEmbed(banId, status);

  const channel = await client.channels.fetch(BAN_LOG_CHANNEL_ID).catch(() => null);
  if (channel) await channel.send({ embeds: [embed] });

  await interaction.editReply({ embeds: [embed] });
}

// Sends an ephemeral follow-up with staff notes and/or unresolved flags for a
// player, if any exist. Used by /lookup-ban, /history and /notes.
async function surfacePlayerInsights(interaction, player, { includeNotes = true } = {}) {
  if (!player) return;
  try {
    const playerNotes = includeNotes ? notes.getNotes(player) : [];
    const playerFlags = flags.getUnresolvedFlagsByIgn(player);
    if (!playerNotes.length && !playerFlags.length) return;
    await interaction.followUp({
      embeds: [buildInsightsEmbed({ player, notes: playerNotes, flags: playerFlags })],
      ephemeral: true,
    }).catch(() => {});
  } catch (err) {
    console.warn('surfacePlayerInsights failed:', err.message);
  }
}

// ── /lookup-ban ────────────────────────────────────────────────────────────────
async function handleLookupBan(interaction) {
  const query = interaction.options.getString('query');
  await interaction.deferReply({ ephemeral: true });

  const byId = await withTimeout(sheets.findBanById(query));
  if (byId) {
    const ban = sheets.rowToBan(byId.rowData);
    await interaction.editReply({ embeds: [buildBanLookupEmbed(ban, { unban: banState.getUnban(ban.ban_id) })] });
    await surfacePlayerInsights(interaction, ban.player_banned);
    return;
  }

  const matches = await withTimeout(sheets.findBansByPlayer(query));
  if (matches.length === 0) {
    await interaction.editReply(`❌ No bans found for \`${query}\`.`);
    await surfacePlayerInsights(interaction, query);
    return;
  }

  // Newest first, one embed per ban, paged through with buttons.
  const embeds = matches.slice().reverse().map(m => {
    const ban = sheets.rowToBan(m.rowData);
    return buildBanLookupEmbed(ban, { unban: banState.getUnban(ban.ban_id) });
  });
  await replyPaginated(interaction, embeds, `Found **${matches.length}** ban(s) for \`${query}\`:`);
  await surfacePlayerInsights(interaction, query);
}

// ── /findban (public: a player looks up their own Ban ID to give to staff) ───────
async function handleFindBan(interaction) {
  const username = interaction.options.getString('username');
  await interaction.deferReply({ ephemeral: true });

  const matches = await withTimeout(sheets.findBansByPlayer(username));
  if (matches.length === 0) {
    return interaction.editReply(
      `✅ No bans found for \`${username}\`. If you think this is wrong, make sure you typed your **exact** in-game name.`,
    );
  }

  // Newest first; cap at 15 lines so the embed description stays within limits.
  const bans = matches.slice().reverse().map(m => sheets.rowToBan(m.rowData)).slice(0, 15);
  let anyActive = false;
  const lines = bans.map(b => {
    const lifted = banState.isUnbanned(b.ban_id);
    if (!lifted && computeBanEnd(b.date, b.duration).state !== 'ended') anyActive = true;
    return myBanLine(b, { lifted });
  });

  return interaction.editReply({ embeds: [buildMyBansEmbed({ username, lines, anyActive })] });
}

// ── /banlist ────────────────────────────────────────────────────────────────────
async function handleBanList(interaction) {
  const scope = interaction.options.getString('scope') || 'active';
  await interaction.deferReply({ ephemeral: true });

  const rows = await withTimeout(sheets.getBanRecords());
  let bans = rows.map(sheets.rowToBan).filter(b => sheets.normalizeBanId(b.ban_id));

  if (scope === 'active') {
    bans = bans.filter(b => !banState.isUnbanned(b.ban_id) && computeBanEnd(b.date, b.duration).state !== 'ended');
  }

  if (bans.length === 0) {
    await interaction.editReply(scope === 'active' ? '✅ There are no active bans right now.' : '❌ No bans found.');
    return;
  }

  // Newest first; compact lines paged at 15 per embed.
  bans.reverse();
  const lines = bans.map(b => banListLine(b, { lifted: banState.isUnbanned(b.ban_id) }));

  const PER_PAGE = 15;
  const total = bans.length;
  const totalPages = Math.ceil(lines.length / PER_PAGE);
  const embeds = [];
  for (let i = 0; i < lines.length; i += PER_PAGE) {
    embeds.push(buildBanListEmbed({ lines: lines.slice(i, i + PER_PAGE), page: embeds.length, totalPages, total, scope }));
  }

  await replyPaginated(interaction, embeds);
}

// ── /unban ──────────────────────────────────────────────────────────────────────
async function handleUnban(interaction) {
  if (!tickets.isStaff(interaction.member)) {
    return interaction.reply({ content: '❌ Only staff can lift bans.', ephemeral: true });
  }
  const banId = interaction.options.getString('ban_id');
  const reason = interaction.options.getString('reason') || '';
  await interaction.deferReply({ ephemeral: true });

  const found = await withTimeout(sheets.findBanById(banId));
  if (!found) {
    return interaction.editReply(`❌ Ban \`ID: ${sheets.normalizeBanId(banId)}\` not found in the sheet.`);
  }
  if (banState.isUnbanned(banId)) {
    return interaction.editReply(`ℹ️ Ban \`ID: ${sheets.normalizeBanId(banId)}\` is already marked as lifted.`);
  }

  const ban = sheets.rowToBan(found.rowData);
  banState.setUnban(banId, { at: new Date().toISOString(), by: interaction.user.id, reason });

  const embed = buildUnbanEmbed({ banId, player: ban.player_banned, byMention: `<@${interaction.user.id}>`, reason });
  const channel = await client.channels.fetch(BAN_LOG_CHANNEL_ID).catch(() => null);
  if (channel) await channel.send({ embeds: [embed] });

  return interaction.editReply({ embeds: [embed] });
}

// ── /stats ────────────────────────────────────────────────────────────────────
async function handleStats(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const [banRows, warRows] = await Promise.all([
    withTimeout(sheets.getBanRecords()),
    withTimeout(sheets.getWarRows()),
  ]);

  const bans = stats.summarizeBans(
    banRows.map(sheets.rowToBan).filter(b => sheets.normalizeBanId(b.ban_id)),
    banState.isUnbanned,
  );
  const wars = stats.summarizeWars(warRows.map(sheets.rowToWar));
  const openTickets = interaction.guild ? tickets.countOpenTickets(interaction.guild) : 0;

  return interaction.editReply({ embeds: [buildStatsEmbed({ bans, wars, openTickets })] });
}

// ── /history ────────────────────────────────────────────────────────────────────
async function handleHistory(interaction) {
  const player = interaction.options.getString('player');
  await interaction.deferReply({ ephemeral: true });

  const matches = await withTimeout(sheets.findBansByPlayer(player));
  if (matches.length === 0) {
    return interaction.editReply(`✅ No bans on record for \`${player}\` — clean slate.`);
  }

  // Newest first; track how many are still active for the header/colour.
  const bans = matches.slice().reverse().map(m => sheets.rowToBan(m.rowData));
  let activeCount = 0;
  const lines = bans.map(b => {
    const lifted = banState.isUnbanned(b.ban_id);
    if (!lifted && computeBanEnd(b.date, b.duration).state !== 'ended') activeCount++;
    return historyLine(b, { lifted });
  });

  const PER_PAGE = 12;
  const total = bans.length;
  const totalPages = Math.ceil(lines.length / PER_PAGE);
  const embeds = [];
  for (let i = 0; i < lines.length; i += PER_PAGE) {
    embeds.push(buildHistoryEmbed({
      player, lines: lines.slice(i, i + PER_PAGE), page: embeds.length, totalPages, total, activeCount,
    }));
  }

  await replyPaginated(interaction, embeds);
  await surfacePlayerInsights(interaction, player);
}

// ── /log-war ────────────────────────────────────────────────────────────────
async function handleLogWar(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const warData = {
    type:            interaction.options.getString('type'),
    requesting_team: interaction.options.getString('requesting_team'),
    target_team:     interaction.options.getString('target_team'),
    reason:          interaction.options.getString('reason'),
    status:          interaction.options.getString('status'),
    outcome_notes:   interaction.options.getString('outcome_notes') || '',
    cooldown_ends:   interaction.options.getString('cooldown_ends') || '',
    war_duration:    interaction.options.getString('war_duration') || '',
    date:            interaction.options.getString('date') || today(),
    approved_by:     interaction.member?.displayName || interaction.user.username,
  };

  await withTimeout(sheets.appendWar(warData), 15000);

  const embed = buildWarEmbed(warData, `<@${interaction.user.id}>`);

  const channel = await client.channels.fetch(WAR_LOG_CHANNEL_ID).catch(() => null);
  if (!channel) {
    console.error('❌ Could not fetch WAR_LOG_CHANNEL_ID:', WAR_LOG_CHANNEL_ID);
    await interaction.editReply('⚠️ Logged to the sheet, but I could not find the war log channel.');
    return;
  }

  await channel.send({ embeds: [embed] });
  await interaction.editReply(`✅ ${warData.type} logged and posted to the war log channel.`);
}

// ── /lookup-war ────────────────────────────────────────────────────────────────
async function handleLookupWar(interaction) {
  const team = interaction.options.getString('team');
  await interaction.deferReply({ ephemeral: true });

  const matches = await withTimeout(sheets.findWarsByTeam(team));
  if (matches.length === 0) {
    await interaction.editReply(`❌ No war/raid records found for \`${team}\`.`);
    return;
  }

  const embeds = matches.slice().reverse().map(m => buildWarLookupEmbed(sheets.rowToWar(m.rowData)));
  await replyPaginated(interaction, embeds, `Found **${matches.length}** record(s) for \`${team}\`:`);
}

// ── /mute (temporary Discord timeout) ──────────────────────────────────────────
async function handleMute(interaction) {
  if (!requireStaff(interaction)) return;
  if (botLacks(interaction, 'ModerateMembers')) {
    return interaction.reply({ content: '❌ I\'m missing the **Moderate Members** permission needed to time members out.', ephemeral: true });
  }

  const target = interaction.options.getMember('user');
  const durationStr = interaction.options.getString('duration');
  const reason = interaction.options.getString('reason') || 'No reason provided';

  if (!target || typeof target.timeout !== 'function') {
    return interaction.reply({ content: '❌ That user isn\'t in this server.', ephemeral: true });
  }
  const ms = parseDurationMs(durationStr);
  if (!ms || ms <= 0) {
    return interaction.reply({ content: '❌ I couldn\'t understand that duration. Try `10m`, `2h`, or `1d`.', ephemeral: true });
  }
  if (ms > MAX_TIMEOUT_MS) {
    return interaction.reply({ content: '❌ Discord timeouts can be at most **28 days**.', ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });
  try {
    await target.timeout(ms, `${reason} — by ${interaction.user.tag}`);
    return interaction.editReply(`🔇 Timed out **${target.user.tag}** for \`${durationStr}\`.`);
  } catch (err) {
    return interaction.editReply(
      `❌ Could not time out <@${target.id}>: \`${err.message}\`\n` +
      '(My role must be **above** theirs, and server owners/admins cannot be timed out.)',
    );
  }
}

// ── /warn + /warnings ────────────────────────────────────────────────────────────
async function handleWarn(interaction) {
  if (!requireStaff(interaction)) return;
  const user = interaction.options.getUser('user');
  const reason = interaction.options.getString('reason') || '';
  await interaction.deferReply({ ephemeral: true });

  const { count } = warnings.addWarning(user.id, { by: interaction.user.id, byTag: interaction.user.tag, reason });

  let dmOk = true;
  try {
    await user.send({ embeds: [buildWarnDmEmbed({ guildName: interaction.guild?.name, reason, count, threshold: WARN_BAN_THRESHOLD })] });
  } catch {
    dmOk = false; // user has DMs closed or shares no DM-able context
  }

  let msg = `⚠️ Warned **${user.tag}** — warning **#${count}**.` + (dmOk ? '' : ' _(Could not DM them.)_');
  if (count >= WARN_BAN_THRESHOLD) {
    msg += `\n🚨 They now have **${count}** warnings (threshold **${WARN_BAN_THRESHOLD}**) — consider a ban.`;
  }
  return interaction.editReply(msg);
}

async function handleWarnings(interaction) {
  if (!requireStaff(interaction)) return;
  const user = interaction.options.getUser('user');
  await interaction.deferReply({ ephemeral: true });
  return interaction.editReply({ embeds: [buildWarningsEmbed({ user, warnings: warnings.getWarnings(user.id) })] });
}

// ── /note + /notes ────────────────────────────────────────────────────────────────
async function handleNote(interaction) {
  if (!requireStaff(interaction)) return;
  const player = interaction.options.getString('player');
  const text = interaction.options.getString('text');
  await interaction.deferReply({ ephemeral: true });
  const entry = notes.addNote(player, { by: interaction.user.id, byTag: interaction.user.tag, text });
  return interaction.editReply(`🗒️ Note \`#${entry.id}\` saved for \`${player}\`. View them with \`/notes player:${player}\`.`);
}

async function handleNotes(interaction) {
  if (!requireStaff(interaction)) return;
  const player = interaction.options.getString('player');
  await interaction.deferReply({ ephemeral: true });
  const list = notes.getNotes(player);
  if (!list.length) {
    await interaction.editReply(`🗒️ No notes on record for \`${player}\`.`);
  } else {
    await interaction.editReply({ embeds: [buildNotesEmbed({ player, notes: list })] });
  }
  // Surface unresolved flags too (notes are already shown above).
  await surfacePlayerInsights(interaction, player, { includeNotes: false });
}

// ── /flags + /resolve-flag ─────────────────────────────────────────────────────────
async function handleFlags(interaction) {
  if (!requireStaff(interaction)) return;
  await interaction.deferReply({ ephemeral: true });
  const list = flags.getUnresolvedFlags().slice().reverse(); // newest first
  if (!list.length) return interaction.editReply('✅ No unresolved flags right now.');

  const PER_PAGE = 6;
  const totalPages = Math.ceil(list.length / PER_PAGE);
  const embeds = [];
  for (let i = 0; i < list.length; i += PER_PAGE) {
    embeds.push(buildFlagsListEmbed({ flags: list.slice(i, i + PER_PAGE), page: embeds.length, totalPages, total: list.length }));
  }
  return replyPaginated(interaction, embeds);
}

async function handleResolveFlag(interaction) {
  if (!requireStaff(interaction)) return;
  const id = interaction.options.getInteger('flag_id');
  const note = interaction.options.getString('note') || '';
  await interaction.deferReply({ ephemeral: true });
  const res = flags.resolveFlag(id, { by: interaction.user.id, note });
  if (!res) return interaction.editReply(`❌ No flag with ID \`#${id}\`.`);
  if (res.already) return interaction.editReply(`ℹ️ Flag \`#${id}\` is already resolved.`);
  return interaction.editReply({ embeds: [buildFlagResolvedEmbed(res.flag)] });
}

// ── /leaderboard ────────────────────────────────────────────────────────────────
async function handleLeaderboard(interaction) {
  if (!requireStaff(interaction)) return;
  await interaction.deferReply({ ephemeral: true });

  const rows = await withTimeout(sheets.getBanRecords());
  const bans = rows.map(sheets.rowToBan).filter(b => sheets.normalizeBanId(b.ban_id));

  const token = Math.random().toString(36).slice(2, 10);
  setTimeout(() => leaderboards.delete(token), PAGINATOR_TTL_MS);
  leaderboards.set(token, { bans });

  const { entries, total } = renderLeaderboard(bans, 'all');
  return interaction.editReply({
    embeds: [buildLeaderboardEmbed({ entries, scope: 'all', total })],
    components: leaderboardComponents(token, 'all'),
  });
}

// ── /priority (set a ticket's priority level) ───────────────────────────────────
async function handlePriority(interaction) {
  const meta = await requireTicket(interaction);
  if (!meta) return;
  if (!requireStaff(interaction)) return;

  const level = interaction.options.getString('level');
  await interaction.deferReply();

  tickets.setPriority(interaction.guild.id, interaction.channel.id, level);

  // Rename the channel (fire-and-forget — channel renames are rate-limited).
  if (!botLacks(interaction, 'ManageChannels')) {
    const newName = tickets.priorityChannelName(interaction.channel.name, level);
    if (newName !== interaction.channel.name) interaction.channel.setName(newName).catch(() => {});
  }

  // Reflect the new priority in the ticket's opening embed.
  await tickets.updateOpenEmbedPriority(interaction.channel, client.user.id, level).catch(() => {});

  // Urgent → ping senior staff unless a senior already has it claimed.
  if (level === 'urgent' && SENIOR_ROLE_IDS.length) {
    const claimerId = tickets.getClaimedBy(interaction.channel);
    let claimerIsSenior = false;
    if (claimerId) {
      const cm = await interaction.guild.members.fetch(claimerId).catch(() => null);
      claimerIsSenior = cm ? tickets.isSenior(cm) : false;
    }
    if (!claimerIsSenior) {
      await interaction.channel.send({
        content: SENIOR_ROLE_IDS.map(r => `<@&${r}>`).join(' '),
        embeds: [buildTicketNoticeEmbed({
          title: 'Urgent Ticket',
          description: `This ticket was marked **🔴 Urgent** by <@${interaction.user.id}> and needs prompt attention.`,
          color: 0xe84343,
          emoji: '🔴',
        })],
        allowedMentions: { roles: SENIOR_ROLE_IDS },
      }).catch(() => {});
    }
  }

  return interaction.editReply({
    embeds: [buildPriorityEmbed({
      label: tickets.priorityLabel(level),
      byMention: `<@${interaction.user.id}>`,
      color: (tickets.PRIORITIES[level] || tickets.PRIORITIES.normal).color,
    })],
  });
}

// ── Help panels (/help, /info-panel, /staff-panel) ──────────────────────────────
function guildIconUrl(interaction) {
  return interaction.guild?.iconURL ? interaction.guild.iconURL({ size: 256 }) : null;
}

// Rough character count of an embed (used to respect Discord's 6000-char /
// message limit when a panel has many embeds).
function embedChars(embed) {
  const j = embed.toJSON();
  let n = (j.title || '').length + (j.description || '').length +
    ((j.footer && j.footer.text) || '').length + ((j.author && j.author.name) || '').length;
  for (const f of j.fields || []) n += f.name.length + f.value.length;
  return n;
}

// Splits embeds into message-sized groups (≤10 embeds and ≤~5800 chars each) so a
// multi-embed panel never trips Discord's per-message limits.
function chunkEmbeds(embeds, { maxChars = 5800, maxEmbeds = 10 } = {}) {
  const groups = [];
  let cur = [];
  let curChars = 0;
  for (const embed of embeds) {
    const c = embedChars(embed);
    if (cur.length && (curChars + c > maxChars || cur.length >= maxEmbeds)) {
      groups.push(cur);
      cur = [];
      curChars = 0;
    }
    cur.push(embed);
    curChars += c;
  }
  if (cur.length) groups.push(cur);
  return groups;
}

// Posts a multi-embed panel to a channel across as many messages as needed.
async function sendPanel(channel, embeds) {
  for (const group of chunkEmbeds(embeds)) {
    await channel.send({ embeds: group });
  }
}

// Replies to an interaction with a multi-embed panel (ephemeral), spilling extra
// embeds into follow-ups when they don't fit one message.
async function replyPanel(interaction, embeds) {
  const groups = chunkEmbeds(embeds);
  await interaction.reply({ embeds: groups[0], ephemeral: true });
  for (let i = 1; i < groups.length; i++) {
    await interaction.followUp({ embeds: groups[i], ephemeral: true });
  }
}

// /help — show the player help board privately to whoever runs it.
async function handleHelp(interaction) {
  return replyPanel(interaction, buildMemberPanel(guildIconUrl(interaction)));
}

// /info-panel — admins post the player board publicly (e.g. in #info).
async function handleInfoPanel(interaction) {
  if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    return interaction.reply({ content: '❌ You need the **Manage Server** permission to post the info panel.', ephemeral: true });
  }
  await interaction.deferReply({ ephemeral: true });
  await sendPanel(interaction.channel, buildMemberPanel(guildIconUrl(interaction)));
  return interaction.editReply('✅ Player info panel posted.');
}

// /staff-panel — admins post the staff handbook (e.g. in the staff channel).
async function handleStaffPanel(interaction) {
  if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    return interaction.reply({ content: '❌ You need the **Manage Server** permission to post the staff panel.', ephemeral: true });
  }
  await interaction.deferReply({ ephemeral: true });
  await sendPanel(interaction.channel, buildStaffPanel(guildIconUrl(interaction)));
  return interaction.editReply('✅ Staff handbook posted.');
}

// ── /ping ─────────────────────────────────────────────────────────────────────
function humanizeUptime(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  parts.push(`${s % 60}s`);
  return parts.join(' ');
}

async function handlePing(interaction) {
  const wsPing = Math.max(0, Math.round(client.ws.ping));
  const uptime = humanizeUptime(client.uptime || 0);
  const openTickets = interaction.guild ? tickets.countOpenTickets(interaction.guild) : 0;
  return interaction.reply({
    embeds: [buildStatusEmbed({ wsPing, uptime, openTickets, online: true })],
    ephemeral: true,
  });
}

// ── Appeal-deadline reminders ───────────────────────────────────────────────────
// Posts a reminder to the ban-log channel for any OPEN, UNCLAIMED ban appeal that
// has sat longer than APPEAL_REMINDER_HOURS. Claiming the ticket stops reminders;
// reminders are throttled to at most once per threshold window per ticket.
async function checkAppealReminders(guild) {
  if (!(APPEAL_REMINDER_HOURS > 0)) return;
  const channel = await client.channels.fetch(BAN_LOG_CHANNEL_ID).catch(() => null);
  if (!channel) return;

  const now = Date.now();
  const thresholdMs = APPEAL_REMINDER_HOURS * 3_600_000;
  const roleIds = tickets.staffPingRoleIds();

  for (const ch of guild.channels.cache.values()) {
    const meta = tickets.decodeTopic(ch.topic);
    if (!meta || meta.type !== 'ban_appeal' || meta.status === 'closed') continue;
    if (tickets.getClaimedBy(ch)) continue;             // already being handled
    const ageMs = now - ch.createdTimestamp;
    if (ageMs < thresholdMs) continue;
    const last = tickets.getAppealReminderAt(guild.id, ch.id);
    if (last && now - last < thresholdMs) continue;     // throttle

    tickets.setAppealReminderAt(guild.id, ch.id, now);
    await channel.send({
      content: roleIds.map(r => `<@&${r}>`).join(' ') || undefined,
      embeds: [buildAppealReminderEmbed({
        channelMention: `<#${ch.id}>`,
        ageHours: Math.round(ageMs / 3_600_000),
        ownerMention: meta.ownerId ? `<@${meta.ownerId}>` : 'someone',
      })],
      allowedMentions: { roles: roleIds },
    }).catch(() => {});
  }
}

// ── Weekly staff activity report ────────────────────────────────────────────────
// On/after Monday 09:00 (server local time), posts a digest of the week that just
// ended to the ban-log channel. Deduplicated per ISO-week via the local store.
async function checkWeeklyReport(guild) {
  const now = new Date();
  const weekStart = report.startOfWeek(now);          // this week's Monday 00:00
  const trigger = new Date(weekStart);
  trigger.setHours(9, 0, 0, 0);                       // Monday 09:00 local
  if (now < trigger) return;

  const mondayIso = weekStart.toISOString().slice(0, 10);
  if (tickets.getLastWeeklyReport(guild.id) === mondayIso) return; // already posted this week

  const channel = await client.channels.fetch(BAN_LOG_CHANNEL_ID).catch(() => null);
  if (!channel) return;

  const [banRows, warRows] = await Promise.all([
    withTimeout(sheets.getBanRecords()).catch(() => []),
    withTimeout(sheets.getWarRows()).catch(() => []),
  ]);

  // Cover the week that just ended: [previous Monday, this Monday).
  const prevMonday = new Date(weekStart);
  prevMonday.setDate(prevMonday.getDate() - 7);
  const data = report.weeklyStaffReport({
    bans: banRows.map(sheets.rowToBan),
    wars: warRows.map(sheets.rowToWar),
    closedTickets: tickets.getClosedTickets(guild.id),
    weekStartMs: prevMonday.getTime(),
    weekEndMs: weekStart.getTime(),
  });

  const weekLabel = `${prevMonday.toISOString().slice(0, 10)} – ${weekStart.toISOString().slice(0, 10)}`;
  await channel.send({ embeds: [buildWeeklyReportEmbed(data, { weekLabel })] }).catch(() => {});
  tickets.setLastWeeklyReport(guild.id, mondayIso);
}

// ── Process-level safety net ────────────────────────────────────────────────────
// A stray rejection or thrown error in an event handler should be logged, not
// allowed to silently crash the bot.
process.on('unhandledRejection', err => {
  console.error('Unhandled promise rejection:', err);
});
process.on('uncaughtException', err => {
  console.error('Uncaught exception:', err);
});

// ── Login ─────────────────────────────────────────────────────────────────────
client.login(process.env.DISCORD_TOKEN);
