// ── Ticket system ───────────────────────────────────────────────────────────
// A control-panel, category-based ticket system. A pinned panel (posted with
// /ticket-panel) holds one button per ticket type. Clicking a button creates a
// private channel inside that type's own category. Staff can claim, add/remove
// users, rename, and close tickets. Closing saves a transcript to a log channel.
//
// State is kept Discord-native: each ticket channel encodes its metadata in the
// channel topic (type/owner/claim/status), and permission overwrites are the
// source of truth for who can see/speak. The only thing persisted to disk
// (data/tickets.json) is the per-type category IDs and the per-type counter, so
// numbering and categories survive restarts.

const fs = require('fs');
const path = require('path');
const {
  ChannelType,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
} = require('discord.js');

const {
  buildPanelEmbed,
  buildTicketOpenEmbed,
  buildTicketClosingEmbed,
  buildTicketCloseLogEmbed,
} = require('./embeds');

// ── Config (from .env) ────────────────────────────────────────────────────────
function splitIds(v) {
  return (v || '').split(',').map(s => s.trim()).filter(Boolean);
}

const STAFF_ROLE_IDS = splitIds(process.env.STAFF_ROLE_IDS);
const SENIOR_ROLE_IDS = splitIds(process.env.SENIOR_ROLE_IDS);
const TICKET_LOG_CHANNEL_ID = process.env.TICKET_LOG_CHANNEL_ID || '';
const STAFF_APP_MIN_DAYS = parseInt(process.env.STAFF_APP_MIN_DAYS || '7', 10);
// Role granted to whitelisted members (on AI approval or /wl-accept).
const MEMBER_ROLE_ID = process.env.MEMBER_ROLE_ID || '';

// ── Ticket type definitions ────────────────────────────────────────────────────
// `short`     → channel-name prefix (e.g. support-0001)
// `style`     → button colour on the panel
// `pingSenior`→ ping SENIOR_ROLE_IDS when the ticket opens (staff reports)
// `minDays`   → minimum days in the server before the type can be opened
const TICKET_TYPES = {
  whitelist: {
    key: 'whitelist',
    label: 'Whitelist Application',
    short: 'whitelist',
    emoji: '📝',
    color: 0x57c454,
    style: ButtonStyle.Success,
    description: 'Apply to be whitelisted and join the server.',
    prompt:
      '• Minecraft username (IGN)\n' +
      '• Your age\n' +
      '• Do you own an original (paid) copy of Minecraft? (yes / no)\n' +
      '• Why do you want to join SovietCraft?\n\n' +
      'When you have answered everything above, click **📨 Submit for Review** below.',
    pingSenior: false,
    minDays: 0,
  },
  support: {
    key: 'support',
    label: 'General Support',
    short: 'support',
    emoji: '🎫',
    color: 0x5865f2,
    style: ButtonStyle.Primary,
    description: 'Get help with general questions or issues.',
    prompt:
      '• Describe your issue or question in as much detail as possible.\n' +
      '• Include any relevant screenshots or your IGN if applicable.',
    pingSenior: false,
    minDays: 0,
  },
  war_raid: {
    key: 'war_raid',
    label: 'War / Raid Request',
    short: 'war-raid',
    emoji: '⚔️',
    color: 0xf0883e,
    style: ButtonStyle.Primary,
    description: 'Request staff approval for a war or raid.',
    prompt:
      '• Request type (War or Raid)\n' +
      '• Your team / nation\n' +
      '• Target team / nation\n' +
      '• Reason for the war / raid',
    pingSenior: false,
    minDays: 0,
  },
  member_report: {
    key: 'member_report',
    label: 'Member Report',
    short: 'report',
    emoji: '🚩',
    color: 0xf0a500,
    style: ButtonStyle.Secondary,
    description: 'Report a player who is breaking the rules.',
    prompt:
      '• Who are you reporting? (IGN / Discord)\n' +
      '• Which rule did they break?\n' +
      '• When did it happen?\n' +
      '• Evidence (screenshots / clips)',
    pingSenior: false,
    minDays: 0,
  },
  staff_report: {
    key: 'staff_report',
    label: 'Staff Report',
    short: 'staff-report',
    emoji: '🛡️',
    color: 0xe84343,
    style: ButtonStyle.Danger,
    description: 'Report a staff member. Handled by senior staff.',
    prompt:
      '• Which staff member are you reporting?\n' +
      '• What happened?\n' +
      '• When did it happen?\n' +
      '• Evidence (screenshots / clips)',
    pingSenior: true,
    minDays: 0,
  },
  staff_app: {
    key: 'staff_app',
    label: 'Staff Application',
    short: 'staff-app',
    emoji: '🪖',
    color: 0xbc8cff,
    style: ButtonStyle.Secondary,
    description: `Apply to join the staff team. (Must be a member for ${STAFF_APP_MIN_DAYS}+ days)`,
    prompt:
      '• Age & timezone\n' +
      '• How many hours per week can you contribute?\n' +
      '• Previous staff experience\n' +
      '• Why should we pick you?',
    pingSenior: false,
    minDays: STAFF_APP_MIN_DAYS,
  },
};

// Order the panel buttons / categories are presented in.
const TYPE_ORDER = ['whitelist', 'support', 'war_raid', 'member_report', 'staff_report', 'staff_app'];

// ── Persistence (data/tickets.json) ────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'tickets.json');

function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return { guilds: {} };
  }
}

function saveStore(store) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
}

function guildCfg(store, guildId) {
  if (!store.guilds[guildId]) {
    store.guilds[guildId] = { categories: {}, counters: {}, panelChannelId: null, claims: {} };
  }
  if (!store.guilds[guildId].claims) store.guilds[guildId].claims = {};
  return store.guilds[guildId];
}

// ── Claim state (kept in the local store, NOT the channel topic) ────────────────
// Editing the channel topic is a rate-limited operation (Discord allows only ~2
// channel name/topic edits per 10 minutes), so persisting claim state there made
// claim/unclaim hang. The JSON store has no such limit.
function getClaim(guildId, channelId) {
  const cfg = guildCfg(loadStore(), guildId);
  return cfg.claims[channelId] || null;
}

function setClaim(guildId, channelId, claimerId) {
  const store = loadStore();
  const cfg = guildCfg(store, guildId);
  if (claimerId) cfg.claims[channelId] = claimerId;
  else delete cfg.claims[channelId];
  saveStore(store);
}

// Convenience for callers that have the channel object.
function getClaimedBy(channel) {
  return channel?.guild ? getClaim(channel.guild.id, channel.id) : null;
}

// ── Role helpers ────────────────────────────────────────────────────────────────
function isStaff(member) {
  if (!member) return false;
  if (member.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  return STAFF_ROLE_IDS.some(r => member.roles.cache.has(r));
}

function isSenior(member) {
  if (!member) return false;
  if (member.permissions?.has(PermissionFlagsBits.Administrator)) return true;
  return SENIOR_ROLE_IDS.some(r => member.roles.cache.has(r));
}

// ── Channel-topic metadata (Discord-native state) ──────────────────────────────
function encodeTopic({ type, ownerId, claimedBy, status }) {
  const t = TICKET_TYPES[type];
  const label = t ? `${t.emoji} ${t.label}` : 'Ticket';
  return `${label} | type:${type} owner:${ownerId} claimed:${claimedBy || 'none'} status:${status || 'open'}`;
}

function decodeTopic(topic) {
  if (!topic) return null;
  const type = (topic.match(/type:(\w+)/) || [])[1];
  const ownerId = (topic.match(/owner:(\d+)/) || [])[1];
  if (!type || !ownerId) return null;
  const claimedRaw = (topic.match(/claimed:(none|\d+)/) || [])[1];
  const status = (topic.match(/status:(open|closed)/) || [])[1] || 'open';
  return {
    type,
    ownerId,
    claimedBy: claimedRaw && claimedRaw !== 'none' ? claimedRaw : null,
    status,
  };
}

// ── Permission overwrites ──────────────────────────────────────────────────────
const STAFF_CHANNEL_PERMS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.ManageMessages,
];

const OWNER_CHANNEL_PERMS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.EmbedLinks,
];

// All staff/senior roles that should be able to see tickets (deduplicated).
function allStaffRoleIds() {
  return [...new Set([...STAFF_ROLE_IDS, ...SENIOR_ROLE_IDS])];
}

// Filters a list of role IDs down to those that actually exist in the guild.
// Passing an unknown role ID to channels.create / permissionOverwrites.edit
// throws an "Unknown Role" error and breaks the whole operation, so we guard.
function validRoleIds(guild, ids) {
  return ids.filter(id => guild.roles.cache.has(id));
}

// Roles to ping for whitelist submissions/appeals — prefer normal staff, falling
// back to senior staff only if no normal staff roles are configured.
function staffPingRoleIds() {
  return STAFF_ROLE_IDS.length ? STAFF_ROLE_IDS : SENIOR_ROLE_IDS;
}

// Overwrites for a category: hidden from @everyone, visible to staff + the bot.
function categoryOverwrites(guild) {
  const ow = [{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }];
  const me = guild.members.me;
  if (me) {
    ow.push({
      id: me.id,
      allow: [...STAFF_CHANNEL_PERMS, PermissionFlagsBits.ManageChannels],
    });
  }
  for (const r of validRoleIds(guild, allStaffRoleIds())) {
    ow.push({ id: r, allow: STAFF_CHANNEL_PERMS });
  }
  return ow;
}

// Overwrites for an individual ticket channel.
function ticketOverwrites(guild, ownerId) {
  const ow = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: ownerId, allow: OWNER_CHANNEL_PERMS },
  ];
  const me = guild.members.me;
  if (me) {
    ow.push({
      id: me.id,
      allow: [...STAFF_CHANNEL_PERMS, PermissionFlagsBits.ManageChannels],
    });
  }
  for (const r of validRoleIds(guild, allStaffRoleIds())) {
    ow.push({ id: r, allow: STAFF_CHANNEL_PERMS });
  }
  return ow;
}

// ── Category management (auto-create) ──────────────────────────────────────────
async function ensureCategories(guild) {
  const store = loadStore();
  const cfg = guildCfg(store, guild.id);

  for (const key of TYPE_ORDER) {
    const t = TICKET_TYPES[key];
    const existingId = cfg.categories[key];

    let cat = existingId ? guild.channels.cache.get(existingId) : null;
    if (!cat && existingId) {
      cat = await guild.channels.fetch(existingId).catch(() => null);
    }

    if (!cat || cat.type !== ChannelType.GuildCategory) {
      cat = await guild.channels.create({
        name: `${t.emoji} ${t.label}`,
        type: ChannelType.GuildCategory,
        permissionOverwrites: categoryOverwrites(guild),
      });
      cfg.categories[key] = cat.id;
    }
  }

  saveStore(store);
  return cfg.categories;
}

// ── Button / panel components ──────────────────────────────────────────────────
function panelComponents() {
  const rows = [];
  let row = new ActionRowBuilder();

  TYPE_ORDER.forEach((key, i) => {
    if (i > 0 && i % 3 === 0) {
      rows.push(row);
      row = new ActionRowBuilder();
    }
    const t = TICKET_TYPES[key];
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`ticket:open:${key}`)
        .setLabel(t.label)
        .setEmoji(t.emoji)
        .setStyle(t.style),
    );
  });
  rows.push(row);
  return rows;
}

// The controls posted on the ticket's opening message. Whitelist tickets also
// get a "Submit for Review" button that triggers the AI reviewer.
function ticketControlComponents(claimed, typeKey) {
  const row = new ActionRowBuilder();

  if (typeKey === 'whitelist') {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId('ticket:wlsubmit')
        .setLabel('Submit for Review')
        .setEmoji('📨')
        .setStyle(ButtonStyle.Primary),
    );
  }

  row.addComponents(
    new ButtonBuilder()
      .setCustomId('ticket:claim')
      .setLabel(claimed ? 'Claimed' : 'Claim')
      .setEmoji('🙋')
      .setStyle(ButtonStyle.Success)
      .setDisabled(!!claimed),
    new ButtonBuilder()
      .setCustomId('ticket:close')
      .setLabel('Close')
      .setEmoji('🔒')
      .setStyle(ButtonStyle.Danger),
  );
  return [row];
}

// Shown after an AI rejection: the applicant can appeal to staff.
function appealComponents() {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket:wlappeal')
      .setLabel('Appeal Decision')
      .setEmoji('📣')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('ticket:close')
      .setLabel('Close')
      .setEmoji('🔒')
      .setStyle(ButtonStyle.Danger),
  );
  return [row];
}

// A bare Close button (used once a whitelist ticket has reached a decision).
function closedControlComponents() {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket:close')
      .setLabel('Close')
      .setEmoji('🔒')
      .setStyle(ButtonStyle.Danger),
  );
  return [row];
}

// The confirm/cancel buttons shown (ephemerally) before a close goes through.
function closeConfirmComponents() {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket:closeConfirm')
      .setLabel('Close Ticket')
      .setEmoji('🔒')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('ticket:closeCancel')
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary),
  );
  return [row];
}

// ── Duplicate-ticket lookup ────────────────────────────────────────────────────
// Scans every channel in the guild and returns the user's first OPEN ticket of
// ANY type (one ticket per user, server-wide), or null. Non-ticket channels are
// skipped automatically because decodeTopic() returns null for them.
function findAnyOpenTicketByUser(guild, userId) {
  for (const ch of guild.channels.cache.values()) {
    const meta = decodeTopic(ch.topic);
    if (meta && meta.ownerId === userId && meta.status !== 'closed') return ch;
  }
  return null;
}

// ── Whitelist helpers ───────────────────────────────────────────────────────
// Concatenates the applicant's own messages in the channel into one block of
// text for the AI reviewer (bot messages and other users are ignored).
async function collectApplicationText(channel, ownerId) {
  const batch = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  if (!batch) return '';
  return [...batch.values()]
    .filter(m => !m.author.bot && m.author.id === ownerId && m.content)
    .reverse()
    .map(m => m.content)
    .join('\n')
    .slice(0, 4000);
}

// Grants the configured member role. Returns { ok } or { ok: false, error }.
async function giveMemberRole(guild, userId) {
  if (!MEMBER_ROLE_ID) return { ok: false, error: 'MEMBER_ROLE_ID is not configured in .env.' };
  try {
    const member = await guild.members.fetch(userId);
    await member.roles.add(MEMBER_ROLE_ID);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Roles to ping when something is escalated to staff (prefer senior staff).
function escalationRoleIds() {
  return SENIOR_ROLE_IDS.length ? SENIOR_ROLE_IDS : STAFF_ROLE_IDS;
}

// ── Create a ticket ────────────────────────────────────────────────────────────
// Returns { ok: true, channel } or { ok: false, message } (a user-facing reason).
// `options.answers` is an optional array of { name, value, inline } rendered as a
// submitted-application embed (used by the whitelist modal).
async function createTicket(guild, member, typeKey, options = {}) {
  const t = TICKET_TYPES[typeKey];
  if (!t) return { ok: false, message: '❌ Unknown ticket type.' };

  // Membership-age gate (Staff Application).
  if (t.minDays > 0) {
    let joined = member.joinedTimestamp;
    if (!joined) {
      const fetched = await guild.members.fetch(member.id).catch(() => null);
      joined = fetched?.joinedTimestamp;
    }
    if (joined) {
      const days = (Date.now() - joined) / 86_400_000;
      if (days < t.minDays) {
        const left = Math.ceil(t.minDays - days);
        return {
          ok: false,
          message:
            `⏳ You must be a member of the server for at least **${t.minDays} day(s)** ` +
            `before opening a **${t.label}**. Please wait **${left} more day(s)** and try again.`,
        };
      }
    }
  }

  // One open ticket per user, server-wide (any type).
  const existing = findAnyOpenTicketByUser(guild, member.id);
  if (existing) {
    return {
      ok: false,
      message: `❗ You already have an open ticket: <#${existing.id}>. Please use or close it before opening a new one.`,
    };
  }

  const categories = await ensureCategories(guild);
  const categoryId = categories[typeKey];

  // Next sequential number for this type.
  const store = loadStore();
  const cfg = guildCfg(store, guild.id);
  const num = (cfg.counters[typeKey] || 0) + 1;
  cfg.counters[typeKey] = num;
  saveStore(store);

  const name = `${t.short}-${String(num).padStart(4, '0')}`;

  const channel = await guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: categoryId,
    topic: encodeTopic({ type: typeKey, ownerId: member.id, claimedBy: null, status: 'open' }),
    permissionOverwrites: ticketOverwrites(guild, member.id),
  });

  // Ping the owner, plus senior staff for staff reports.
  const mentions = [`<@${member.id}>`];
  const roleMentions = [];
  if (t.pingSenior && SENIOR_ROLE_IDS.length) {
    for (const r of SENIOR_ROLE_IDS) mentions.push(`<@&${r}>`);
    roleMentions.push(...SENIOR_ROLE_IDS);
  }

  await channel.send({
    content: mentions.join(' '),
    embeds: [buildTicketOpenEmbed(t, `<@${member.id}>`, t.prompt)],
    components: ticketControlComponents(false, typeKey),
    allowedMentions: { users: [member.id], roles: roleMentions },
  });

  return { ok: true, channel };
}

// ── Claim / unclaim ─────────────────────────────────────────────────────────────
// Claiming locks the ticket: regular staff roles lose SendMessages, while the
// claimer and senior staff keep it. The owner is unaffected.
async function claimTicket(channel, claimerId) {
  const meta = decodeTopic(channel.topic);
  if (!meta) return { ok: false, message: 'This is not a ticket channel.' };
  const current = getClaim(channel.guild.id, channel.id);
  if (current) return { ok: false, message: `This ticket is already claimed by <@${current}>.` };

  // Lock: non-senior staff lose send; senior staff + claimer keep it.
  for (const r of validRoleIds(channel.guild, STAFF_ROLE_IDS)) {
    if (SENIOR_ROLE_IDS.includes(r)) continue;
    await channel.permissionOverwrites.edit(r, { SendMessages: false }).catch(() => {});
  }
  for (const r of validRoleIds(channel.guild, SENIOR_ROLE_IDS)) {
    await channel.permissionOverwrites.edit(r, { ViewChannel: true, SendMessages: true }).catch(() => {});
  }
  await channel.permissionOverwrites.edit(claimerId, { ViewChannel: true, SendMessages: true }).catch(() => {});

  setClaim(channel.guild.id, channel.id, claimerId);

  // Cosmetic rename (support-0001 → CLM-support-0001). Fire-and-forget so the
  // channel-rename rate limit (2 / 10 min) never blocks the command response.
  if (!channel.name.startsWith('CLM-')) {
    channel.setName(`CLM-${channel.name}`).catch(() => {});
  }

  return { ok: true, meta };
}

async function unclaimTicket(channel) {
  const meta = decodeTopic(channel.topic);
  if (!meta) return { ok: false, message: 'This is not a ticket channel.' };
  const current = getClaim(channel.guild.id, channel.id);
  if (!current) return { ok: false, message: 'This ticket is not currently claimed.' };

  for (const r of validRoleIds(channel.guild, STAFF_ROLE_IDS)) {
    if (SENIOR_ROLE_IDS.includes(r)) continue;
    await channel.permissionOverwrites.edit(r, { SendMessages: true }).catch(() => {});
  }

  setClaim(channel.guild.id, channel.id, null);

  // Restore the original name (drop CLM-). Fire-and-forget (rename rate limit).
  if (channel.name.startsWith('CLM-')) {
    channel.setName(channel.name.slice(4)).catch(() => {});
  }

  return { ok: true, meta, previousClaim: current };
}

// ── Add / remove a user ─────────────────────────────────────────────────────────
async function addUserToTicket(channel, userId) {
  await channel.permissionOverwrites.edit(userId, {
    ViewChannel: true,
    SendMessages: true,
    ReadMessageHistory: true,
    AttachFiles: true,
  });
}

async function removeUserFromTicket(channel, userId) {
  await channel.permissionOverwrites.delete(userId);
}

// ── Transcript + close ──────────────────────────────────────────────────────────
async function buildTranscript(channel) {
  const all = [];
  let before;
  for (let i = 0; i < 10; i++) { // up to 1000 messages
    const batch = await channel.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch || batch.size === 0) break;
    all.push(...batch.values());
    before = batch.last().id;
    if (batch.size < 100) break;
  }
  all.reverse();

  const lines = all.map(m => {
    const time = new Date(m.createdTimestamp).toISOString().replace('T', ' ').slice(0, 19);
    let content = m.content || '';
    if (m.embeds?.length) content += ` [${m.embeds.length} embed(s)]`;
    if (m.attachments?.size) {
      content += ' ' + [...m.attachments.values()].map(a => `<${a.url}>`).join(' ');
    }
    return `[${time} UTC] ${m.author.tag}: ${content}`.trimEnd();
  });

  return { text: lines.join('\n'), count: all.length };
}

function humanizeDuration(ms) {
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

// Archives the ticket (transcript + summary to the log channel) and deletes it.
async function closeTicket(channel, closedByMember, reason, client) {
  const meta = decodeTopic(channel.topic) || {};
  const t = TICKET_TYPES[meta.type] || { label: 'Ticket' };
  const claimedBy = channel.guild ? getClaim(channel.guild.id, channel.id) : null;
  if (channel.guild) setClaim(channel.guild.id, channel.id, null); // clean up state

  const { text, count } = await buildTranscript(channel);
  const opened = channel.createdTimestamp;

  const info = {
    channelName: channel.name,
    typeLabel: t.label,
    ownerMention: meta.ownerId ? `<@${meta.ownerId}>` : '`Unknown`',
    claimedMention: claimedBy ? `<@${claimedBy}>` : null,
    closedByMention: `<@${closedByMember.id}>`,
    messageCount: count,
    openedAt: `<t:${Math.floor(opened / 1000)}:F>`,
    duration: humanizeDuration(Date.now() - opened),
    reason: reason || null,
  };

  if (TICKET_LOG_CHANNEL_ID) {
    const logCh = await client.channels.fetch(TICKET_LOG_CHANNEL_ID).catch(() => null);
    if (logCh) {
      const file = new AttachmentBuilder(Buffer.from(text || 'No messages were sent.', 'utf8'), {
        name: `transcript-${channel.name}.txt`,
      });
      await logCh
        .send({ embeds: [buildTicketCloseLogEmbed(info)], files: [file] })
        .catch(err => console.error('❌ Failed to post ticket transcript:', err));
    } else {
      console.error('❌ Could not fetch TICKET_LOG_CHANNEL_ID:', TICKET_LOG_CHANNEL_ID);
    }
  }

  await channel.send({ embeds: [buildTicketClosingEmbed(info)] }).catch(() => {});
  setTimeout(() => channel.delete('Ticket closed').catch(() => {}), 5000);
}

// ── Post the control panel ──────────────────────────────────────────────────────
async function postPanel(guild, channel) {
  await ensureCategories(guild);
  const types = TYPE_ORDER.map(k => TICKET_TYPES[k]);
  const guildIcon = guild.iconURL ? guild.iconURL({ size: 256 }) : null;
  await channel.send({ embeds: [buildPanelEmbed(types, guildIcon)], components: panelComponents() });

  const store = loadStore();
  const cfg = guildCfg(store, guild.id);
  cfg.panelChannelId = channel.id;
  saveStore(store);
}

// Counts currently-open ticket channels across all categories in the guild.
function countOpenTickets(guild) {
  let n = 0;
  for (const ch of guild.channels.cache.values()) {
    const meta = decodeTopic(ch.topic);
    if (meta && meta.status !== 'closed') n++;
  }
  return n;
}

module.exports = {
  TICKET_TYPES,
  isStaff,
  isSenior,
  decodeTopic,
  ensureCategories,
  postPanel,
  createTicket,
  claimTicket,
  unclaimTicket,
  addUserToTicket,
  removeUserFromTicket,
  closeTicket,
  ticketControlComponents,
  closeConfirmComponents,
  appealComponents,
  closedControlComponents,
  findAnyOpenTicketByUser,
  collectApplicationText,
  giveMemberRole,
  escalationRoleIds,
  staffPingRoleIds,
  countOpenTickets,
  getClaimedBy,
};
