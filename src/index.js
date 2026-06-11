require('dotenv').config();

const { Client, GatewayIntentBits, Events, Collection, PermissionFlagsBits } = require('discord.js');

const sheets = require('./sheets');
const tickets = require('./tickets');
const ai = require('./ai');
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
  buildHelpEmbed,
  buildStatusEmbed,
} = require('./embeds');

// ── Config ──────────────────────────────────────────────────────────────────
const BAN_LOG_CHANNEL_ID = process.env.BAN_LOG_CHANNEL_ID;
const WAR_LOG_CHANNEL_ID = process.env.WAR_LOG_CHANNEL_ID;
const SENIOR_ROLE_IDS = (process.env.SENIOR_ROLE_IDS || '')
  .split(',')
  .map(id => id.trim())
  .filter(Boolean);

// Severities that trigger a senior-staff ping.
const PING_SEVERITIES = new Set(['HIGH', 'CRITICAL', 'PERMANENT']);
const EVIDENCE_WINDOW_MS = 2 * 60 * 1000;

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
    const missing = ['ManageChannels', 'ManageRoles']
      .filter(p => !me.permissions.has(PermissionFlagsBits[p]));
    if (missing.length) {
      lines.push(`⚠️  Missing permission(s) in "${guild.name}": ${missing.join(', ')} — ticket/role features may not work.`);
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
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    switch (interaction.commandName) {
      case 'log-ban':       return await handleLogBan(interaction);
      case 'update-appeal': return await handleUpdateAppeal(interaction);
      case 'lookup-ban':    return await handleLookupBan(interaction);
      case 'log-war':       return await handleLogWar(interaction);
      case 'lookup-war':    return await handleLookupWar(interaction);
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
    return interaction.editReply(`✅ Your **${label}** ticket has been created: <#${res.channel.id}>`);
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
    const roleRes = await tickets.giveMemberRole(interaction.guild, meta.ownerId);
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
    return interaction.editReply('✅ Your application was approved and you now have the member role! This ticket will close shortly.');
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

// ── /wl-accept ──────────────────────────────────────────────────────────────────
async function handleWlAccept(interaction) {
  if (!tickets.isStaff(interaction.member)) {
    return interaction.reply({ content: '❌ Only staff can use this command.', ephemeral: true });
  }
  if (!(await ensureBotCanManageRoles(interaction))) return;
  const user = interaction.options.getUser('user');
  await interaction.deferReply();

  const res = await withTimeout(tickets.giveMemberRole(interaction.guild, user.id));
  if (!res.ok) {
    return interaction.editReply(`❌ Could not assign the member role to <@${user.id}>: \`${res.error}\`\n(Make sure my role is **above** the member role and I have **Manage Roles**.)`);
  }
  return interaction.editReply({
    embeds: [buildTicketNoticeEmbed({
      title: 'Whitelist Accepted',
      description: `<@${user.id}> has been given the member role by <@${interaction.user.id}>. Welcome aboard! 🎉`,
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
    evidenceUrls: [],
    expiresAt: Date.now() + EVIDENCE_WINDOW_MS,
    timeout,
  });

  await interaction.reply({
    content:
      `✅ Ban details recorded for **${banData.player_banned}** (ID will be assigned automatically).\n\n` +
      `📎 **Upload your evidence screenshot(s) in this channel within 2 minutes.**\n` +
      `Each upload is auto-removed to keep the channel clean. Type \`done\` when finished ` +
      `(or just wait — I'll log it automatically once the window closes).`,
    ephemeral: true,
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

// Writes the ban to the sheet, posts the embed to the log channel, and clears
// the pending state. Called from both the "done"/upload path and the timeout.
async function finalizeBan(userId, { reason } = {}) {
  const pending = pendingEvidence.get(userId);
  if (!pending) return;
  if (pending.timeout) clearTimeout(pending.timeout);
  pendingEvidence.delete(userId);

  const { banData, evidenceUrls, interaction } = pending;

  // Timeout with nothing uploaded → tell the user and bail.
  if (reason === 'timeout' && evidenceUrls.length === 0) {
    await interaction
      .editReply('⏰ Evidence window closed with no screenshots uploaded. Run `/log-ban` again to retry.')
      .catch(() => {});
    return;
  }

  try {
    const banId = await sheets.appendBan(banData, evidenceUrls);

    const formatted = { ...banData, ban_id: banId };
    const banEmbed = buildBanEmbed(formatted, evidenceUrls, `<@${banData.staff_id}>`);

    const channel = await client.channels.fetch(BAN_LOG_CHANNEL_ID).catch(() => null);
    if (!channel) {
      console.error('❌ Could not fetch BAN_LOG_CHANNEL_ID:', BAN_LOG_CHANNEL_ID);
    } else {
      const shouldPing = PING_SEVERITIES.has(String(banData.severity).toUpperCase());
      const content = shouldPing && SENIOR_ROLE_IDS.length
        ? `${SENIOR_ROLE_IDS.map(id => `<@&${id}>`).join(' ')} — **${banData.severity}** severity ban logged.`
        : undefined;
      await channel.send({
        content,
        embeds: [banEmbed],
        allowedMentions: { roles: SENIOR_ROLE_IDS },
      });
    }

    await interaction
      .editReply(`✅ Ban \`${formatted.ban_id}\` logged with ${evidenceUrls.length} screenshot(s) and posted.`)
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

  const imageUrls = [...message.attachments.values()]
    .filter(a => a.contentType?.startsWith('image/'))
    .map(a => a.url);
  const isDone = message.content.trim().toLowerCase() === 'done';

  if (imageUrls.length === 0 && !isDone) return; // ignore unrelated chatter

  // Auto-delete the submission to keep the channel clean.
  await safeDelete(message);

  if (imageUrls.length > 0) {
    pending.evidenceUrls.push(...imageUrls);
    await pending.interaction
      .editReply(
        `📎 Collected **${pending.evidenceUrls.length}** screenshot(s). ` +
        `Upload more or type \`done\` to finish.`,
      )
      .catch(() => {});
  }

  if (isDone) {
    if (pending.evidenceUrls.length === 0) {
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

  const updated = await sheets.updateAppealStatus(banId, status);
  if (!updated) {
    await interaction.editReply(`❌ Ban \`ID: ${sheets.normalizeBanId(banId)}\` not found in the sheet.`);
    return;
  }

  const embed = buildAppealUpdateEmbed(banId, status);

  const channel = await client.channels.fetch(BAN_LOG_CHANNEL_ID).catch(() => null);
  if (channel) await channel.send({ embeds: [embed] });

  await interaction.editReply({ embeds: [embed] });
}

// ── /lookup-ban ────────────────────────────────────────────────────────────────
async function handleLookupBan(interaction) {
  const query = interaction.options.getString('query');
  await interaction.deferReply({ ephemeral: true });

  const byId = await sheets.findBanById(query);
  if (byId) {
    await interaction.editReply({ embeds: [buildBanLookupEmbed(sheets.rowToBan(byId.rowData))] });
    return;
  }

  const matches = await sheets.findBansByPlayer(query);
  if (matches.length === 0) {
    await interaction.editReply(`❌ No bans found for \`${query}\`.`);
    return;
  }

  // Up to 3 most recent (rows are oldest-first, so take the tail and reverse).
  const embeds = matches.slice(-3).reverse().map(m => buildBanLookupEmbed(sheets.rowToBan(m.rowData)));
  await interaction.editReply({
    content: `Found **${matches.length}** ban(s) for \`${query}\` — showing the ${embeds.length} most recent:`,
    embeds,
  });
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

  await sheets.appendWar(warData);

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

  const matches = await sheets.findWarsByTeam(team);
  if (matches.length === 0) {
    await interaction.editReply(`❌ No war/raid records found for \`${team}\`.`);
    return;
  }

  const embeds = matches.slice(-3).reverse().map(m => buildWarLookupEmbed(sheets.rowToWar(m.rowData)));
  await interaction.editReply({
    content: `Found **${matches.length}** record(s) for \`${team}\` — showing the ${embeds.length} most recent:`,
    embeds,
  });
}

// ── /help ─────────────────────────────────────────────────────────────────────
async function handleHelp(interaction) {
  const staff = tickets.isStaff(interaction.member);
  return interaction.reply({ embeds: [buildHelpEmbed({ isStaff: staff })], ephemeral: true });
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

// ── Login ─────────────────────────────────────────────────────────────────────
client.login(process.env.DISCORD_TOKEN);
