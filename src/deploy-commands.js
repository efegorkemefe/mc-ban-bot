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

  // ── Moderation / utility ──────────────────────────────────────────────────────
  // /mute — temporary Discord timeout (no logging).
  new SlashCommandBuilder()
    .setName('mute')
    .setDescription('Temporarily time out a member (Discord timeout)')
    .setDMPermission(false)
    .addUserOption(o => o.setName('user').setDescription('Member to time out').setRequired(true))
    .addStringOption(o => o.setName('duration').setDescription('Duration, e.g. 10m / 2h / 1d (max 28d)').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason (audit log only)').setRequired(false))
    .toJSON(),

  // /warn — issue a formal warning (stored locally, DMs the user).
  new SlashCommandBuilder()
    .setName('warn')
    .setDescription('Issue a formal warning to a user (DMs them)')
    .setDMPermission(false)
    .addUserOption(o => o.setName('user').setDescription('User to warn').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason for the warning').setRequired(false))
    .toJSON(),

  // /warnings — view a user's warning history.
  new SlashCommandBuilder()
    .setName('warnings')
    .setDescription("View a user's warning history")
    .setDMPermission(false)
    .addUserOption(o => o.setName('user').setDescription('User to look up').setRequired(true))
    .toJSON(),

  // /note — attach a private staff note to a player username.
  new SlashCommandBuilder()
    .setName('note')
    .setDescription('Attach a private staff note to a player username')
    .setDMPermission(false)
    .addStringOption(o => o.setName('player').setDescription('Minecraft username (IGN)').setRequired(true))
    .addStringOption(o => o.setName('text').setDescription('The note text').setRequired(true))
    .toJSON(),

  // /notes — list staff notes for a player.
  new SlashCommandBuilder()
    .setName('notes')
    .setDescription('List staff notes for a player username')
    .setDMPermission(false)
    .addStringOption(o => o.setName('player').setDescription('Minecraft username (IGN)').setRequired(true))
    .toJSON(),

  // /flags — view unresolved alt-detection flags.
  new SlashCommandBuilder()
    .setName('flags')
    .setDescription('View unresolved alt-detection flags (paged)')
    .setDMPermission(false)
    .toJSON(),

  // /resolve-flag — mark a flag resolved.
  new SlashCommandBuilder()
    .setName('resolve-flag')
    .setDescription('Mark an alt-detection flag as resolved')
    .setDMPermission(false)
    .addIntegerOption(o => o.setName('flag_id').setDescription('Flag ID (the number shown in /flags)').setRequired(true))
    .addStringOption(o => o.setName('note').setDescription('Optional resolution note').setRequired(false))
    .toJSON(),

  // /leaderboard — ranked staff by bans logged.
  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Show the staff ban leaderboard (toggle This Week / All Time)')
    .setDMPermission(false)
    .toJSON(),

  // /priority — set the current ticket's priority level.
  new SlashCommandBuilder()
    .setName('priority')
    .setDescription("Set this ticket's priority level")
    .setDMPermission(false)
    .addStringOption(o => o.setName('level').setDescription('Priority level').setRequired(true).addChoices(
      { name: 'Low', value: 'low' },
      { name: 'Normal', value: 'normal' },
      { name: 'Urgent', value: 'urgent' },
    ))
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

  // /help — show the player help board privately.
  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show the player help & info guide (private to you)')
    .toJSON(),

  // /info-panel — admins post the player help board (e.g. in #info).
  new SlashCommandBuilder()
    .setName('info-panel')
    .setDescription('Post the player Help & Info board in this channel (admin)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .toJSON(),

  // /staff-panel — admins post the staff handbook (e.g. in the staff channel).
  new SlashCommandBuilder()
    .setName('staff-panel')
    .setDescription('Post the staff handbook board in this channel (admin)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .toJSON(),

  // /ping — bot status / health.
  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check the bot status, latency, and uptime')
    .toJSON(),

  // ── Staff Roster ──────────────────────────────────────────────────────────────
  // Gating is in-code via roster.getStaffTier (tier 1/2/3), so no default member
  // permissions are set — tier-1/2 staff aren't Discord admins.

  // /roster — view a staff profile (self any tier; others tier 2+).
  new SlashCommandBuilder()
    .setName('roster')
    .setDescription('View a staff member\'s roster profile (defaults to yourself)')
    .setDMPermission(false)
    .addUserOption(o => o.setName('user').setDescription('Staff member to view (omit for yourself)').setRequired(false))
    .toJSON(),

  // /roster-list — paged overview of all active staff (tier 2+).
  new SlashCommandBuilder()
    .setName('roster-list')
    .setDescription('List all active staff with tier, quota status, and strikes (senior+)')
    .setDMPermission(false)
    .toJSON(),

  // /eligible — staff currently meeting promotion criteria (tier 2+).
  new SlashCommandBuilder()
    .setName('eligible')
    .setDescription('List staff who currently meet all promotion criteria (senior+)')
    .setDMPermission(false)
    .toJSON(),

  // /staff-warn — add a warn to a staff member (tier 3).
  new SlashCommandBuilder()
    .setName('staff-warn')
    .setDescription('Issue a warning to a staff member (super staff only)')
    .setDMPermission(false)
    .addUserOption(o => o.setName('user').setDescription('Staff member to warn').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason for the warning').setRequired(false))
    .toJSON(),

  // /staff-strike — add a strike (more severe) to a staff member (tier 3).
  new SlashCommandBuilder()
    .setName('staff-strike')
    .setDescription('Issue a strike to a staff member (super staff only)')
    .setDMPermission(false)
    .addUserOption(o => o.setName('user').setDescription('Staff member to strike').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason for the strike').setRequired(false))
    .toJSON(),

  // /staff-pardon — pardon a specific warn/strike by ID (tier 3).
  new SlashCommandBuilder()
    .setName('staff-pardon')
    .setDescription('Pardon a staff warn or strike by its ID (super staff only)')
    .setDMPermission(false)
    .addUserOption(o => o.setName('user').setDescription('Staff member').setRequired(true))
    .addStringOption(o => o.setName('type').setDescription('Pardon a warn or a strike').setRequired(true).addChoices(
      { name: 'Warn', value: 'warn' },
      { name: 'Strike', value: 'strike' },
    ))
    .addIntegerOption(o => o.setName('id').setDescription('The warn/strike ID (see /staff-record)').setRequired(true))
    .toJSON(),

  // /staff-record — full warn/strike history (self any tier; others tier 2+).
  new SlashCommandBuilder()
    .setName('staff-record')
    .setDescription('View a staff member\'s warn/strike history (defaults to yourself)')
    .setDMPermission(false)
    .addUserOption(o => o.setName('user').setDescription('Staff member (omit for yourself)').setRequired(false))
    .toJSON(),

  // /roster-onboard — add someone to the roster + assign tier roles (tier 3).
  new SlashCommandBuilder()
    .setName('roster-onboard')
    .setDescription('Onboard a new staff member at a tier (super staff only)')
    .setDMPermission(false)
    .addUserOption(o => o.setName('user').setDescription('The new staff member').setRequired(true))
    .addIntegerOption(o => o.setName('tier').setDescription('Staff tier').setRequired(true).addChoices(
      { name: 'Staff (tier 1)', value: 1 },
      { name: 'Senior Staff (tier 2)', value: 2 },
      { name: 'Super Staff (tier 3)', value: 3 },
    ))
    .toJSON(),

  // /roster-offboard — clean voluntary exit (tier 3).
  new SlashCommandBuilder()
    .setName('roster-offboard')
    .setDescription('Offboard a staff member (clean exit, archived) — super staff only')
    .setDMPermission(false)
    .addUserOption(o => o.setName('user').setDescription('Staff member to offboard').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason (optional)').setRequired(false))
    .toJSON(),

  // /roster-edit — manual field override (tier 3).
  new SlashCommandBuilder()
    .setName('roster-edit')
    .setDescription('Manually correct a roster field (super staff only)')
    .setDMPermission(false)
    .addUserOption(o => o.setName('user').setDescription('Staff member').setRequired(true))
    .addStringOption(o => o.setName('field').setDescription('Which field to correct').setRequired(true).addChoices(
      { name: 'Tier (1/2/3)', value: 'tier' },
      { name: 'Tenure start (YYYY-MM-DD)', value: 'tenureStart' },
      { name: 'Staff join date (YYYY-MM-DD)', value: 'staffJoinDate' },
      { name: 'Status (active/loa/suspended)', value: 'status' },
    ))
    .addStringOption(o => o.setName('value').setDescription('The new value').setRequired(true))
    .toJSON(),

  // /suspend — temporary functional removal (tier 3).
  new SlashCommandBuilder()
    .setName('suspend')
    .setDescription('Temporarily suspend a staff member (super staff only)')
    .setDMPermission(false)
    .addUserOption(o => o.setName('user').setDescription('Staff member to suspend').setRequired(true))
    .addStringOption(o => o.setName('duration').setDescription('Duration, e.g. 7d / 48h (blank = until manually lifted)').setRequired(false))
    .addStringOption(o => o.setName('reason').setDescription('Reason (optional)').setRequired(false))
    .toJSON(),

  // /suspend-lift — end a suspension early (tier 3).
  new SlashCommandBuilder()
    .setName('suspend-lift')
    .setDescription('End a suspension early and reinstate the member (super staff only)')
    .setDMPermission(false)
    .addUserOption(o => o.setName('user').setDescription('Suspended staff member').setRequired(true))
    .toJSON(),

  // /suspension-list — currently suspended staff (tier 2+).
  new SlashCommandBuilder()
    .setName('suspension-list')
    .setDescription('List currently suspended staff (senior+)')
    .setDMPermission(false)
    .toJSON(),

  // /terminate — permanent removal for cause, button-confirmed (tier 3).
  new SlashCommandBuilder()
    .setName('terminate')
    .setDescription('Permanently terminate a staff member for cause (super staff only)')
    .setDMPermission(false)
    .addUserOption(o => o.setName('user').setDescription('Staff member to terminate').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason (optional)').setRequired(false))
    .toJSON(),

  // /quota-status — weekly activity progress (self any tier; others tier 2+).
  new SlashCommandBuilder()
    .setName('quota-status')
    .setDescription('Show weekly activity quota progress (defaults to yourself)')
    .setDMPermission(false)
    .addUserOption(o => o.setName('user').setDescription('Staff member (omit for yourself)').setRequired(false))
    .toJSON(),

  // /activity-toggle — turn the activity system on/off (tier 3).
  new SlashCommandBuilder()
    .setName('activity-toggle')
    .setDescription('Turn the staff activity / quota system on or off (super staff only)')
    .setDMPermission(false)
    .addStringOption(o => o.setName('state').setDescription('On or off').setRequired(true).addChoices(
      { name: 'On', value: 'on' },
      { name: 'Off', value: 'off' },
    ))
    .toJSON(),

  // /activity-status — show on/off + current quotas (anyone).
  new SlashCommandBuilder()
    .setName('activity-status')
    .setDescription('Show whether activity tracking is on and the current weekly quotas')
    .setDMPermission(false)
    .toJSON(),

  // /loa-request — request a leave of absence (any staff).
  new SlashCommandBuilder()
    .setName('loa-request')
    .setDescription('Request a leave of absence (senior staff approve)')
    .setDMPermission(false)
    .addStringOption(o => o.setName('reason').setDescription('Reason for the LOA').setRequired(false))
    .addStringOption(o => o.setName('return_date').setDescription('Expected return date, e.g. 2026-07-01').setRequired(false))
    .toJSON(),

  // /loa-approve — approve a pending LOA (tier 2+).
  new SlashCommandBuilder()
    .setName('loa-approve')
    .setDescription('Approve a staff member\'s LOA request (senior+)')
    .setDMPermission(false)
    .addUserOption(o => o.setName('user').setDescription('Staff member whose LOA to approve').setRequired(true))
    .toJSON(),

  // /loa-deny — deny a pending LOA (tier 2+).
  new SlashCommandBuilder()
    .setName('loa-deny')
    .setDescription('Deny a staff member\'s LOA request (senior+)')
    .setDMPermission(false)
    .addUserOption(o => o.setName('user').setDescription('Staff member whose LOA to deny').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason (optional)').setRequired(false))
    .toJSON(),

  // /loa-end — end an LOA (self, or senior+ for others).
  new SlashCommandBuilder()
    .setName('loa-end')
    .setDescription('End a leave of absence (yourself, or senior+ for others)')
    .setDMPermission(false)
    .addUserOption(o => o.setName('user').setDescription('Staff member (omit for yourself)').setRequired(false))
    .toJSON(),

  // /loa-list — staff currently on LOA (tier 2+).
  new SlashCommandBuilder()
    .setName('loa-list')
    .setDescription('List staff currently on leave of absence (senior+)')
    .setDMPermission(false)
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
