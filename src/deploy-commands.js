require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

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
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log('Registering slash commands...');
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
    console.log(`✅ Registered ${commands.length} slash commands successfully.`);
  } catch (err) {
    console.error('❌ Failed to register commands:', err);
    process.exitCode = 1;
  }
})();
