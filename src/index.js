require('dotenv').config();

const { Client, GatewayIntentBits, Events, Collection } = require('discord.js');

const sheets = require('./sheets');
const {
  buildBanEmbed,
  buildWarEmbed,
  buildAppealUpdateEmbed,
  buildBanLookupEmbed,
  buildWarLookupEmbed,
  buildConfirmEmbed,
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

client.once(Events.ClientReady, c => {
  console.log(`✅ Logged in as ${c.user.tag}`);
});

// ── Slash command router ────────────────────────────────────────────────────
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;

  try {
    switch (interaction.commandName) {
      case 'log-ban':      return await handleLogBan(interaction);
      case 'update-appeal': return await handleUpdateAppeal(interaction);
      case 'lookup-ban':   return await handleLookupBan(interaction);
      case 'log-war':      return await handleLogWar(interaction);
      case 'lookup-war':   return await handleLookupWar(interaction);
    }
  } catch (err) {
    console.error(`Error handling /${interaction.commandName}:`, err);
    const msg = '❌ Something went wrong. Check the bot logs.';
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(msg).catch(() => {});
    } else {
      await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
    }
  }
});

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

// ── Login ─────────────────────────────────────────────────────────────────────
client.login(process.env.DISCORD_TOKEN);
