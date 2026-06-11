require('dotenv').config();
const { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

const SEVERITY_CHOICES = [
  { name: 'LOW', value: 'LOW' },
  { name: 'MEDIUM', value: 'MEDIUM' },
  { name: 'HIGH', value: 'HIGH' },
  { name: 'CRITICAL', value: 'CRITICAL' },
  { name: 'PERMANENT', value: 'PERMANENT' },
];

const APPEAL_CHOICES = [
  { name: 'Appealable', value: 'Appealable' },
  { name: 'Unappealable', value: 'Unappealable' },
  { name: 'N/A', value: 'N/A' },
];

const WAR_TYPE_CHOICES = [
  { name: 'Raid', value: 'Raid' },
  { name: 'War', value: 'War' },
];

const WAR_STATUS_CHOICES = [
  { name: 'APPROVED', value: 'APPROVED' },
  { name: 'DENIED', value: 'DENIED' },
  { name: 'PENDING', value: 'PENDING' },
];

const commands = [
  // ── /log-ban ────────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('log-ban')
    .setDescription('Log a player ban (ID is auto-assigned; you upload evidence after)')
    .addStringOption(o => o.setName('player_banned').setDescription('Minecraft username of the banned player').setRequired(true))
    .addStringOption(o => o.setName('offense').setDescription('What they did').setRequired(true))
    .addStringOption(o => o.setName('severity').setDescription('Severity level').setRequired(true).addChoices(...SEVERITY_CHOICES))
    .addStringOption(o => o.setName('duration').setDescription('Ban duration, e.g. 7d / Permanent').setRequired(true))
    .addStringOption(o => o.setName('appeal_status').setDescription('Appeal status').setRequired(true).addChoices(...APPEAL_CHOICES))
    .addStringOption(o => o.setName('date').setDescription('Date YYYY-MM-DD (defaults to today)').setRequired(false))
    .toJSON(),

  // ── /update-appeal ────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('update-appeal')
    .setDescription('Update the appeal status for a ban')
    .addStringOption(o => o.setName('ban_id').setDescription('Ban ID, e.g. 004').setRequired(true))
    .addStringOption(o => o.setName('status').setDescription('New appeal status').setRequired(true).addChoices(...APPEAL_CHOICES))
    .toJSON(),

  // ── /lookup-ban ────────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('lookup-ban')
    .setDescription('Look up a ban by ID or player username')
    .addStringOption(o => o.setName('query').setDescription('Ban ID (e.g. 004) or player username').setRequired(true))
    .toJSON(),

  // ── /findban ────────────────────────────────────────────────────────────────────
  // Public, so a banned player can find their own Ban ID to give to staff.
  new SlashCommandBuilder()
    .setName('findban')
    .setDescription('Find your Ban ID by Minecraft username (to give to staff for an appeal)')
    .addStringOption(o => o.setName('username').setDescription('Your exact Minecraft username').setRequired(true))
    .toJSON(),

  // ── /banlist ────────────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('banlist')
    .setDescription('List banned players (compact)')
    .addStringOption(o => o.setName('scope').setDescription('Which bans to show (default: active)').setRequired(false).addChoices(
      { name: 'Active only', value: 'active' },
      { name: 'All', value: 'all' },
    ))
    .toJSON(),

  // ── /unban ────────────────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('unban')
    .setDescription('Mark a ban as lifted and announce it in the ban log')
    .addStringOption(o => o.setName('ban_id').setDescription('Ban ID, e.g. 004').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Why the ban is being lifted').setRequired(false))
    .toJSON(),

  // ── /stats ────────────────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Show the moderation dashboard (bans, wars, tickets)')
    .toJSON(),

  // ── /history ────────────────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('history')
    .setDescription('Show a player\'s ban history timeline')
    .addStringOption(o => o.setName('player').setDescription('Minecraft username to look up').setRequired(true))
    .toJSON(),

  // ── /log-war ────────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('log-war')
    .setDescription('Log a war or raid approval')
    .addStringOption(o => o.setName('type').setDescription('Raid or War').setRequired(true).addChoices(...WAR_TYPE_CHOICES))
    .addStringOption(o => o.setName('requesting_team').setDescription('Requesting team / player').setRequired(true))
    .addStringOption(o => o.setName('target_team').setDescription('Target team / player').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason provided').setRequired(true))
    .addStringOption(o => o.setName('status').setDescription('Approval status').setRequired(true).addChoices(...WAR_STATUS_CHOICES))
    .addStringOption(o => o.setName('outcome_notes').setDescription('Outcome / notes').setRequired(false))
    .addStringOption(o => o.setName('cooldown_ends').setDescription('When the cooldown ends').setRequired(false))
    .addStringOption(o => o.setName('war_duration').setDescription('Duration of the war').setRequired(false))
    .addStringOption(o => o.setName('date').setDescription('Date YYYY-MM-DD (defaults to today)').setRequired(false))
    .toJSON(),

  // ── /lookup-war ────────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('lookup-war')
    .setDescription('Look up war/raid records by team')
    .addStringOption(o => o.setName('team').setDescription('Team / player name to search for').setRequired(true))
    .toJSON(),

  // ── Ticket system ───────────────────────────────────────────────────────────
  // /ticket-panel — admins post the control panel (auto-creates categories).
  new SlashCommandBuilder()
    .setName('ticket-panel')
    .setDescription('Post the ticket control panel in this channel (admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .toJSON(),

  // /add — add a user to the current ticket. (Access is gated in-code by role.)
  new SlashCommandBuilder()
    .setName('add')
    .setDescription('Add a user to this ticket')
    .setDMPermission(false)
    .addUserOption(o => o.setName('user').setDescription('The user to add').setRequired(true))
    .toJSON(),

  // /remove — remove a user from the current ticket.
  new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Remove a user from this ticket')
    .setDMPermission(false)
    .addUserOption(o => o.setName('user').setDescription('The user to remove').setRequired(true))
    .toJSON(),

  // /claim — claim the current ticket (locks out other regular staff).
  new SlashCommandBuilder()
    .setName('claim')
    .setDescription('Claim this ticket so only you and senior staff can respond')
    .setDMPermission(false)
    .toJSON(),

  // /unclaim — release a claimed ticket.
  new SlashCommandBuilder()
    .setName('unclaim')
    .setDescription('Release this ticket so all staff can respond again')
    .setDMPermission(false)
    .toJSON(),

  // /rename — rename the current ticket channel.
  new SlashCommandBuilder()
    .setName('rename')
    .setDescription('Rename this ticket channel')
    .setDMPermission(false)
    .addStringOption(o => o.setName('name').setDescription('The new channel name').setRequired(true))
    .toJSON(),

  // /close — archive (transcript) and delete the current ticket.
  new SlashCommandBuilder()
    .setName('close')
    .setDescription('Close this ticket (saves a transcript, then deletes the channel)')
    .setDMPermission(false)
    .addStringOption(o => o.setName('reason').setDescription('Optional reason for closing').setRequired(false))
    .toJSON(),

  // /wl-accept — manually approve a whitelist applicant and grant the member role.
  new SlashCommandBuilder()
    .setName('wl-accept')
    .setDescription('Approve a whitelist applicant and give them the member role')
    .setDMPermission(false)
    .addUserOption(o => o.setName('user').setDescription('The user to whitelist').setRequired(true))
    .toJSON(),

  // /help — command reference.
  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show how to use the bot and list available commands')
    .toJSON(),

  // /ping — bot status / health.
  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check the bot status, latency, and uptime')
    .toJSON(),
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    // If GUILD_ID is set, register to that guild only — updates are near-instant,
    // which is ideal for development. Without it, register globally (can take up
    // to ~1 hour to propagate) for production use across every server.
    const guildId = process.env.GUILD_ID;
    const route = guildId
      ? Routes.applicationGuildCommands(process.env.CLIENT_ID, guildId)
      : Routes.applicationCommands(process.env.CLIENT_ID);

    console.log(`Registering slash commands ${guildId ? `to guild ${guildId}` : 'globally'}...`);
    await rest.put(route, { body: commands });
    console.log(`✅ Registered ${commands.length} slash commands successfully.`);
  } catch (err) {
    console.error('❌ Failed to register commands:', err);
    process.exitCode = 1;
  }
})();
