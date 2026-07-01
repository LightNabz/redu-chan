/**
 * =============================================================================
 * Combined Discord Bot — GitHub Commit Tracker + Anti-Scam OCR/Blast Detector
 * =============================================================================
 * Stack : discord.js v14, tesseract.js v5, node-cron, Node.js >= 18
 *
 * Merged from two standalone bots:
 *   1. GitHub commit tracker  (/ping, /repo, /logchannel, "Redu-chan" easter egg)
 *   2. Anti-phishing detector (/watch, /list, /action, /keywords, /config)
 *
 * Anti-phishing detection surfaces:
 *   SURFACE A — OCR Keyword Pipeline (mention-gated)
 *     Fires when a message contains a high-risk mention (@everyone / @here /
 *     a watched role) AND an image attachment. Tesseract reads the image and
 *     counts keyword hits against the per-guild keyword list. Triggers the
 *     punishment pipeline when hits >= threshold (default 2).
 *
 *   SURFACE B — Cross-Channel Image Blast Detection (mention-free)
 *     Catches bots that post silently with no mentions. Every image
 *     attachment is fingerprinted (filename + byte-size) and logged in a
 *     short-lived velocity store. If the same fingerprint appears in N
 *     distinct channels within T seconds (configurable via /config), the
 *     punishment pipeline fires regardless of mentions or OCR results.
 *
 * All staff controls are Slash Commands gated to Administrator at the
 * Discord API layer — non-admins cannot see them.
 *
 * Required environment variables (see .env):
 *   DISCORD_TOKEN   — bot token
 *   GUILD_ID        — (optional) guild ID for instant slash command registration
 * =============================================================================
 */

require('dotenv').config();
'use strict';

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  SlashCommandBuilder,
  PermissionFlagsBits,
  REST,
  Routes,
  InteractionType,
} = require('discord.js');
const cron = require('node-cron');
const Tesseract = require('tesseract.js');
const { fetchCommits } = require('./github');
const { db, saveDB } = require('./db');

// ---------------------------------------------------------------------------
// ACTION WEIGHT TABLE (static — not guild-configurable)
// ---------------------------------------------------------------------------

/**
 * Maps action names to execution priority weights.
 * Higher weight → runs first.  The ordering prevents Discord API errors:
 *
 *   delete  (100) — kill the message before any user clicks a link
 *   send_dm  (80) — DM the victim while the bot still shares the guild
 *   mute     (50) — timeout the account to stop further blasts
 *   kick     (20) — remove from guild (must follow DM)
 *   ban      (10) — permanent removal (always last)
 */
const ACTION_WEIGHTS = Object.freeze({
  delete: 100,
  send_dm: 80,
  mute: 50,
  kick: 20,
  ban: 10,
});

// ---------------------------------------------------------------------------
// DEFAULT SCAM KEYWORDS (used when a guild has not customised its list)
// ---------------------------------------------------------------------------

const DEFAULT_KEYWORDS = Object.freeze([
  'mr. beast',
  'mrbeast',
  'promo code',
  'dasowin',
  'giveaway',
  'claim',
  'deposit',
]);

// ---------------------------------------------------------------------------
// PER-GUILD ANTI-PHISHING CONFIG STORE
// ---------------------------------------------------------------------------

/**
 * In-memory config store keyed by guild ID.
 *
 * Per-guild shape:
 * {
 *   watched_roles    : string[]  — role IDs that trigger the OCR pipeline
 *   actions          : string[]  — active punishment names
 *   keywords         : string[]  — OCR scam keywords (starts as DEFAULT_KEYWORDS copy)
 *   keyword_threshold: number    — minimum keyword hits to fire (default 2)
 *   blast_channels   : number    — distinct channels needed to trigger blast detection (default 3)
 *   blast_window_ms  : number    — rolling time window for blast detection in ms (default 60 000)
 * }
 *
 * Swap this Map for SQLite / Postgres / Redis for persistence across restarts.
 */
const guildConfigs = new Map();

/**
 * Returns a guild's anti-phishing config, initialising it with safe defaults
 * on first access.
 * @param {string} guildId
 */
function getGuildConfig(guildId) {
  if (!guildConfigs.has(guildId)) {
    guildConfigs.set(guildId, {
      watched_roles: [],
      actions: ['delete', 'send_dm', 'mute'],
      keywords: [...DEFAULT_KEYWORDS],
      keyword_threshold: 2,
      blast_channels: 3,
      blast_window_ms: 60_000,
    });
  }
  return guildConfigs.get(guildId);
}

// ---------------------------------------------------------------------------
// CROSS-CHANNEL BLAST VELOCITY STORE
// ---------------------------------------------------------------------------

/**
 * Tracks recent image posts for cross-channel blast detection.
 *
 * Structure:
 *   blastStore
 *     └─ guildId  (Map)
 *           └─ fingerprint  (Array of { channelId: string, messageId: string, timestamp: number })
 *
 * Fingerprint formula:  `${attachment.name}::${attachment.size}`
 *
 * Why name+size instead of a crypto hash?
 *   • Scam selfbots re-upload the exact same binary file — name and byte-size
 *     are deterministic and identical across every blast channel.
 *   • Computing a SHA-256 of the downloaded image bytes would require fetching
 *     every attachment on every message, destroying the "passive unless needed"
 *     performance guarantee. name+size gives equivalent collision resistance
 *     for this threat model at zero download cost.
 *
 * A periodic sweep (BLAST_SWEEP_INTERVAL_MS) removes entries older than the
 * longest configured blast window to prevent unbounded memory growth.
 */
const blastStore = new Map();

/** How often to run the stale-entry sweep (ms). */
const BLAST_SWEEP_INTERVAL_MS = 5 * 60_000; // every 5 minutes

/**
 * Produces a cheap, collision-resistant fingerprint for an image attachment.
 * @param {import('discord.js').Attachment} attachment
 * @returns {string}
 */
function attachmentFingerprint(attachment) {
  return `${attachment.name}::${attachment.size}`;
}

/**
 * Records an image sighting in the blast store and returns whether the
 * cross-channel blast threshold has been reached for this guild.
 *
 * @param {string} guildId
 * @param {string} channelId
 * @param {string} messageId
 * @param {string} fingerprint
 * @param {{ blast_channels: number, blast_window_ms: number }} config
 * @returns {{ triggered: boolean, channelCount: number, sightings: Array<{channelId:string, messageId:string, timestamp:number}> }}
 */
function recordAndCheckBlast(guildId, channelId, messageId, fingerprint, config) {
  const now = Date.now();
  const cutoff = now - config.blast_window_ms;

  if (!blastStore.has(guildId)) blastStore.set(guildId, new Map());
  const guildMap = blastStore.get(guildId);

  if (!guildMap.has(fingerprint)) guildMap.set(fingerprint, []);
  const sightings = guildMap.get(fingerprint).filter(s => s.timestamp >= cutoff);

  // Only record one entry per channel — a bot flooding a single channel
  // multiple times should not inflate the unique-channel count.
  const existingIdx = sightings.findIndex(s => s.channelId === channelId);
  if (existingIdx === -1) {
    sightings.push({ channelId, messageId, timestamp: now });
  } else {
    sightings[existingIdx].messageId = messageId;
    sightings[existingIdx].timestamp = now;
  }

  guildMap.set(fingerprint, sightings);

  const uniqueChannels = new Set(sightings.map(s => s.channelId)).size;
  return {
    triggered: uniqueChannels >= config.blast_channels,
    channelCount: uniqueChannels,
    sightings,
  };
}

/**
 * Sweeps the blast store, removing fingerprints whose most recent sighting is
 * older than the longest blast window of any guild. Prevents memory leaks on
 * long-running bots.
 */
function sweepBlastStore() {
  const now = Date.now();
  for (const [guildId, guildMap] of blastStore) {
    const config = getGuildConfig(guildId);
    const cutoff = now - config.blast_window_ms;
    for (const [fingerprint, sightings] of guildMap) {
      const fresh = sightings.filter(s => s.timestamp >= cutoff);
      if (fresh.length === 0) {
        guildMap.delete(fingerprint);
      } else {
        guildMap.set(fingerprint, fresh);
      }
    }
    if (guildMap.size === 0) blastStore.delete(guildId);
  }
  console.log('[SWEEP] Blast store cleaned.');
}

setInterval(sweepBlastStore, BLAST_SWEEP_INTERVAL_MS);

// ---------------------------------------------------------------------------
// CLIENT
// ---------------------------------------------------------------------------

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // Privileged — enable in Dev Portal
    GatewayIntentBits.GuildMembers,   // Privileged — enable in Dev Portal (mute/kick/ban)
  ],
});

// ── Slash command definitions ──────────────────────────────────────────────

const commands = [
  // ── /ping ──
  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check if the bot is alive and see latency info')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  // ── /repo ──
  new SlashCommandBuilder()
    .setName('repo')
    .setDescription('Manage tracked repositories')
    .addSubcommand(sub =>
      sub.setName('add')
        .setDescription('Track a new GitHub repository')
        .addStringOption(opt =>
          opt.setName('url')
            .setDescription('GitHub repo URL (e.g. https://github.com/owner/repo)')
            .setRequired(true)))
    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('List all tracked repositories'))
    .addSubcommand(sub =>
      sub.setName('remove')
        .setDescription('Stop tracking a repository')
        .addStringOption(opt =>
          opt.setName('id')
            .setDescription('Repository ID (from /repo list)')
            .setRequired(true)))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  // ── /logchannel ──
  new SlashCommandBuilder()
    .setName('logchannel')
    .setDescription('Manage commit log channels')
    .addSubcommand(sub =>
      sub.setName('set')
        .setDescription('Set the global fallback log channel for all repos')
        .addChannelOption(opt =>
          opt.setName('channel')
            .setDescription('Channel to send all commit logs to')
            .setRequired(true)))
    .addSubcommand(sub =>
      sub.setName('setrepo')
        .setDescription('Set a log channel for a specific repo')
        .addStringOption(opt =>
          opt.setName('repo_id')
            .setDescription('Repo ID (from /repo list)')
            .setRequired(true))
        .addChannelOption(opt =>
          opt.setName('channel')
            .setDescription('Channel to send this repo\'s commit logs to')
            .setRequired(true)))
    .addSubcommand(sub =>
      sub.setName('unsetrepo')
        .setDescription('Remove a repo-specific channel so it falls back to global')
        .addStringOption(opt =>
          opt.setName('repo_id')
            .setDescription('Repo ID to reset to global')
            .setRequired(true)))
    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('Show all configured log channels'))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  // ── /watch add|remove <role> ──
  new SlashCommandBuilder()
    .setName('watch')
    .setDescription('Manage roles that trigger the OCR pipeline.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub =>
      sub.setName('add')
        .setDescription('Add a role to the high-risk watch list.')
        .addRoleOption(o => o.setName('role').setDescription('Role to monitor').setRequired(true)))
    .addSubcommand(sub =>
      sub.setName('remove')
        .setDescription('Remove a role from the high-risk watch list.')
        .addRoleOption(o => o.setName('role').setDescription('Role to stop monitoring').setRequired(true))),

  // ── /list (anti-phishing watched roles) ──
  new SlashCommandBuilder()
    .setName('watchlist')
    .setDescription('Show currently monitored roles for the anti-phishing OCR pipeline.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  // ── /action add|remove|list ──
  new SlashCommandBuilder()
    .setName('action')
    .setDescription('Configure the active punishment pipeline.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub =>
      sub.setName('add')
        .setDescription('Add a punishment to the pipeline.')
        .addStringOption(o =>
          o.setName('type').setDescription('Punishment type').setRequired(true)
            .addChoices(
              { name: 'delete  (weight 100)', value: 'delete' },
              { name: 'send_dm (weight  80)', value: 'send_dm' },
              { name: 'mute    (weight  50)', value: 'mute' },
              { name: 'kick    (weight  20)', value: 'kick' },
              { name: 'ban     (weight  10)', value: 'ban' },
            )))
    .addSubcommand(sub =>
      sub.setName('remove')
        .setDescription('Remove a punishment from the pipeline.')
        .addStringOption(o =>
          o.setName('type').setDescription('Punishment type').setRequired(true)
            .addChoices(
              { name: 'delete', value: 'delete' },
              { name: 'send_dm', value: 'send_dm' },
              { name: 'mute', value: 'mute' },
              { name: 'kick', value: 'kick' },
              { name: 'ban', value: 'ban' },
            )))
    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('Show the active punishments in execution order.')),

  // ── /keywords add|remove|list ──
  new SlashCommandBuilder()
    .setName('keywords')
    .setDescription('Manage the OCR scam keyword list for this server.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub =>
      sub.setName('add')
        .setDescription('Add a keyword or phrase to the scam detection list.')
        .addStringOption(o =>
          o.setName('keyword').setDescription('Word or phrase to flag (case-insensitive)').setRequired(true)))
    .addSubcommand(sub =>
      sub.setName('remove')
        .setDescription('Remove a keyword from the scam detection list.')
        .addStringOption(o =>
          o.setName('keyword').setDescription('Word or phrase to remove').setRequired(true)))
    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('Show all active scam keywords for this server.')),

  // ── /phishconfig ──
  new SlashCommandBuilder()
    .setName('phishconfig')
    .setDescription('Tune anti-phishing detection thresholds.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub =>
      sub.setName('blast-threshold')
        .setDescription('Set how many channels + window trigger the blast detector.')
        .addIntegerOption(o =>
          o.setName('channels').setDescription('Distinct channel count to trigger (default 3)')
            .setRequired(true).setMinValue(2).setMaxValue(20))
        .addIntegerOption(o =>
          o.setName('seconds').setDescription('Rolling time window in seconds (default 60)')
            .setRequired(true).setMinValue(5).setMaxValue(300)))
    .addSubcommand(sub =>
      sub.setName('keyword-threshold')
        .setDescription('Set how many keyword hits are needed to trigger OCR punishment.')
        .addIntegerOption(o =>
          o.setName('count').setDescription('Minimum keyword hits (default 2)')
            .setRequired(true).setMinValue(1).setMaxValue(10))),
].map(cmd => cmd.toJSON());

// ── Bot ready ──────────────────────────────────────────────────────────────

client.once('ready', async () => {
  console.log(`[OK] Logged in as ${client.user.tag}`);
  console.log(`[OK] In ${client.guilds.cache.size} guild(s)`);

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  if (process.env.GUILD_ID) {
    // Guild-scoped: registers instantly, perfect for development
    try {
      await rest.put(
        Routes.applicationGuildCommands(client.user.id, process.env.GUILD_ID),
        { body: commands }
      );
      console.log(`[OK] Slash commands registered instantly to guild ${process.env.GUILD_ID}`);
    } catch (err) {
      console.error('[ERR] Failed to register guild commands:', err.message);
      console.error('      Make sure the bot was invited with the applications.commands scope.');
    }
  } else {
    // Global: can take up to 1 hour to propagate across Discord
    try {
      await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
      console.log('[OK] Slash commands registered globally (may take up to 1 hour to appear)');
      console.log('     Tip: set GUILD_ID=your_server_id for instant registration');
    } catch (err) {
      console.error('[ERR] Failed to register global commands:', err.message);
      console.error('      Make sure the bot was invited with the applications.commands scope.');
    }
  }

  // Start polling every 5 minutes
  cron.schedule('*/5 * * * *', () => pollCommits(client));
  console.log('[OK] Polling GitHub every 5 minutes');
});

// ── Interaction handler ────────────────────────────────────────────────────

client.on('interactionCreate', async interaction => {
  if (interaction.type !== InteractionType.ApplicationCommand) return;
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  // ── /ping ────────────────────────────────────────────────────────────────

  if (commandName === 'ping') {
    const sent = await interaction.reply({ content: '🏓 Pinging...', fetchReply: true });
    const roundtrip = sent.createdTimestamp - interaction.createdTimestamp;
    const wsHeartbeat = client.ws.ping;

    const embed = new EmbedBuilder()
      .setColor(roundtrip < 200 ? 0x2DA44E : roundtrip < 500 ? 0xE3B341 : 0xF85149)
      .setTitle('🏓 Pong!')
      .addFields(
        { name: '↩️ Roundtrip', value: `\`${roundtrip}ms\``, inline: true },
        { name: '💓 WS Heartbeat', value: `\`${wsHeartbeat}ms\``, inline: true },
        { name: '📦 Repos tracked', value: `\`${db.repos.length}\``, inline: true },
      )
      .setFooter({ text: `Shard ${client.ws.shards.first()?.id ?? 0}` })
      .setTimestamp();

    return interaction.editReply({ content: '', embeds: [embed] });
  }

  // ── /repo ─────────────────────────────────────────────────────────────────

  if (commandName === 'repo') {
    const sub = interaction.options.getSubcommand();

    if (sub === 'add') {
      const url = interaction.options.getString('url').trim();
      const parsed = parseGitHubURL(url);
      if (!parsed) {
        return interaction.reply({ content: '❌ Invalid GitHub URL. Use `https://github.com/owner/repo`', ephemeral: true });
      }

      const existing = db.repos.find(r => r.owner === parsed.owner && r.repo === parsed.repo);
      if (existing) {
        return interaction.reply({ content: `⚠️ That repo is already tracked as **#${existing.id}**.`, ephemeral: true });
      }

      const id = ++db.nextId;
      db.repos.push({ id, owner: parsed.owner, repo: parsed.repo, url, lastSHA: null });
      saveDB();

      const embed = new EmbedBuilder()
        .setColor(0x238636)
        .setTitle('✅ Repository Added')
        .addFields(
          { name: 'ID', value: `\`${id}\``, inline: true },
          { name: 'Repo', value: `[${parsed.owner}/${parsed.repo}](${url})`, inline: true }
        )
        .setFooter({ text: 'Commits will be polled every 5 minutes' });

      return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'list') {
      if (!db.repos.length) {
        return interaction.reply({ content: '📭 No repositories tracked yet. Use `/repo add` to get started.', ephemeral: true });
      }

      const embed = new EmbedBuilder()
        .setColor(0x0d1117)
        .setTitle('📋 Tracked Repositories')
        .setDescription(
          db.repos.map(r => {
            const channel = db.channels[`repo_${r.id}`] || db.channels['global'];
            const channelStr = channel ? `<#${channel}>` : '*(no channel set)*';
            return `**#${r.id}** — [${r.owner}/${r.repo}](${r.url}) → ${channelStr}`;
          }).join('\n')
        );

      return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'remove') {
      const id = parseInt(interaction.options.getString('id'));
      const idx = db.repos.findIndex(r => r.id === id);
      if (idx === -1) {
        return interaction.reply({ content: `❌ No repository with ID \`${id}\`.`, ephemeral: true });
      }

      const [removed] = db.repos.splice(idx, 1);
      delete db.channels[`repo_${id}`];
      saveDB();

      return interaction.reply({
        content: `🗑️ Removed **${removed.owner}/${removed.repo}** (ID: \`${id}\`)`,
      });
    }
  }

  // ── /logchannel ───────────────────────────────────────────────────────────

  if (commandName === 'logchannel') {
    const sub = interaction.options.getSubcommand();

    if (sub === 'set') {
      const channel = interaction.options.getChannel('channel');
      db.channels['global'] = channel.id;
      saveDB();
      return interaction.reply({
        content: `✅ Global log channel set to <#${channel.id}>. All repos without a specific channel will log here.`,
      });
    }

    if (sub === 'setrepo') {
      const repoId = parseInt(interaction.options.getString('repo_id'));
      const channel = interaction.options.getChannel('channel');
      const repo = db.repos.find(r => r.id === repoId);
      if (!repo) {
        return interaction.reply({ content: `❌ No repository with ID \`${repoId}\`.`, ephemeral: true });
      }
      db.channels[`repo_${repoId}`] = channel.id;
      saveDB();
      return interaction.reply({
        content: `✅ Commit logs for **${repo.owner}/${repo.repo}** will be sent to <#${channel.id}>.`,
      });
    }

    if (sub === 'unsetrepo') {
      const repoId = parseInt(interaction.options.getString('repo_id'));
      const repo = db.repos.find(r => r.id === repoId);
      if (!repo) {
        return interaction.reply({ content: `❌ No repository with ID \`${repoId}\`.`, ephemeral: true });
      }
      if (!db.channels[`repo_${repoId}`]) {
        return interaction.reply({ content: `⚠️ **${repo.owner}/${repo.repo}** doesn't have a specific channel set — it's already using the global channel.`, ephemeral: true });
      }
      delete db.channels[`repo_${repoId}`];
      saveDB();
      const globalChannel = db.channels['global'];
      const fallback = globalChannel
        ? ` It will now fall back to the global channel <#${globalChannel}>.`
        : ' No global channel is configured yet — set one with `/logchannel set`.';
      return interaction.reply({
        content: `✅ Removed specific log channel for **${repo.owner}/${repo.repo}**.${fallback}`,
      });
    }

    if (sub === 'list') {
      const lines = [];

      if (db.channels['global']) {
        lines.push(`🌐 **Global fallback** → <#${db.channels['global']}>`);
      } else {
        lines.push('🌐 **Global fallback** → *(not set)*');
      }

      if (db.repos.length) {
        lines.push('');
        for (const repo of db.repos) {
          const key = `repo_${repo.id}`;
          const channelStr = db.channels[key] ? `<#${db.channels[key]}>` : '*(uses global)*';
          lines.push(`📦 **#${repo.id}** \`${repo.owner}/${repo.repo}\` → ${channelStr}`);
        }
      }

      const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('📡 Log Channel Configuration')
        .setDescription(lines.join('\n'));

      return interaction.reply({ embeds: [embed] });
    }
  }

  // ── Anti-phishing commands (deferred + wrapped, matching original) ────────

  if (['watch', 'watchlist', 'action', 'keywords', 'phishconfig'].includes(commandName)) {
    if (!interaction.guild) return;
    const config = getGuildConfig(interaction.guild.id);

    await interaction.deferReply({ ephemeral: true });

    try {
      // ── /watch ─────────────────────────────────────────────────────────
      if (commandName === 'watch') {
        const sub = interaction.options.getSubcommand();
        const role = interaction.options.getRole('role', true);

        if (sub === 'add') {
          if (config.watched_roles.includes(role.id))
            return interaction.editReply(`⚠️ **${role.name}** is already on the watch list.`);
          config.watched_roles.push(role.id);
          return interaction.editReply(
            `✅ **${role.name}** added to the watch list.\n` +
            `*(@everyone and @here are always monitored.)*`
          );
        }
        if (sub === 'remove') {
          if (!config.watched_roles.includes(role.id))
            return interaction.editReply(`⚠️ **${role.name}** is not on the watch list.`);
          config.watched_roles = config.watched_roles.filter(id => id !== role.id);
          return interaction.editReply(`🗑️ **${role.name}** removed from the watch list.`);
        }
      }

      // ── /watchlist ─────────────────────────────────────────────────────
      if (commandName === 'watchlist') {
        if (config.watched_roles.length === 0)
          return interaction.editReply(
            `📋 **Hardcoded triggers:** \`@everyone\`, \`@here\`\n` +
            `📋 **Custom roles:** *(none)*`
          );
        const roleList = config.watched_roles.map(id => `<@&${id}>`).join(', ');
        return interaction.editReply(
          `📋 **Hardcoded triggers:** \`@everyone\`, \`@here\`\n` +
          `📋 **Custom roles:** ${roleList}`
        );
      }

      // ── /action ────────────────────────────────────────────────────────
      if (commandName === 'action') {
        const sub = interaction.options.getSubcommand();

        if (sub === 'list') {
          if (config.actions.length === 0)
            return interaction.editReply(
              `⚙️ **Active punishments:** *(none — bot will detect but not act!)*`
            );
          const lines = [...config.actions]
            .sort((a, b) => (ACTION_WEIGHTS[b] ?? 0) - (ACTION_WEIGHTS[a] ?? 0))
            .map((act, i) => `\`${i + 1}.\` **${act}** — weight ${ACTION_WEIGHTS[act]}`)
            .join('\n');
          return interaction.editReply(`⚙️ **Punishment pipeline (execution order):**\n${lines}`);
        }

        const actionType = interaction.options.getString('type', true);

        if (sub === 'add') {
          if (config.actions.includes(actionType))
            return interaction.editReply(`⚠️ \`${actionType}\` is already active.`);
          config.actions.push(actionType);
          return interaction.editReply(`✅ \`${actionType}\` added to the pipeline.`);
        }
        if (sub === 'remove') {
          if (!config.actions.includes(actionType))
            return interaction.editReply(`⚠️ \`${actionType}\` is not active.`);
          config.actions = config.actions.filter(a => a !== actionType);
          return interaction.editReply(`🗑️ \`${actionType}\` removed from the pipeline.`);
        }
      }

      // ── /keywords ──────────────────────────────────────────────────────
      if (commandName === 'keywords') {
        const sub = interaction.options.getSubcommand();

        if (sub === 'list') {
          if (config.keywords.length === 0)
            return interaction.editReply(`📝 **Keyword list is empty.** OCR scan will never match.`);
          const formatted = config.keywords.map(k => `\`${k}\``).join(', ');
          return interaction.editReply(
            `📝 **Active scam keywords (${config.keywords.length}) — ` +
            `threshold: ${config.keyword_threshold} hit(s) required:**\n${formatted}`
          );
        }

        const keyword = interaction.options.getString('keyword', true).toLowerCase().trim();

        if (!keyword)
          return interaction.editReply(`❌ Keyword cannot be empty.`);

        if (sub === 'add') {
          if (config.keywords.includes(keyword))
            return interaction.editReply(`⚠️ \`${keyword}\` is already in the keyword list.`);
          config.keywords.push(keyword);
          return interaction.editReply(
            `✅ \`${keyword}\` added to the keyword list.\n` +
            `*(${config.keywords.length} keyword(s) active — threshold: ${config.keyword_threshold})*`
          );
        }
        if (sub === 'remove') {
          if (!config.keywords.includes(keyword))
            return interaction.editReply(`⚠️ \`${keyword}\` is not in the keyword list.`);
          config.keywords = config.keywords.filter(k => k !== keyword);
          return interaction.editReply(
            `🗑️ \`${keyword}\` removed.\n` +
            `*(${config.keywords.length} keyword(s) remaining)*`
          );
        }
      }

      // ── /phishconfig ───────────────────────────────────────────────────
      if (commandName === 'phishconfig') {
        const sub = interaction.options.getSubcommand();

        if (sub === 'blast-threshold') {
          const channels = interaction.options.getInteger('channels', true);
          const seconds = interaction.options.getInteger('seconds', true);
          config.blast_channels = channels;
          config.blast_window_ms = seconds * 1000;
          return interaction.editReply(
            `✅ **Blast detector updated:**\n` +
            `• Triggers when the same image appears in **${channels} distinct channels**\n` +
            `• within a **${seconds}-second** rolling window.`
          );
        }

        if (sub === 'keyword-threshold') {
          const count = interaction.options.getInteger('count', true);
          config.keyword_threshold = count;
          return interaction.editReply(
            `✅ **OCR keyword threshold set to ${count}.**\n` +
            `At least **${count}** keyword(s) must appear in an image to trigger punishment.\n` +
            `*(${config.keywords.length} keyword(s) currently active.)*`
          );
        }
      }
    } catch (err) {
      console.error(`[COMMAND ERROR] /${commandName}:`, err);
      try {
        await interaction.editReply('❌ An internal error occurred. Check bot logs.');
      } catch { /* interaction may have already expired */ }
    }
  }
});

// ── Message listener (Redu-chan easter egg + anti-phishing detection) ──────

client.on('messageCreate', async message => {
  if (message.author.bot) return;

  // ── Redu-chan easter egg (works everywhere, including DMs) ──
  const isDirectMention = message.mentions.users.has(client.user.id);
  const isRoleMention = message.guild
    ? message.mentions.roles.some(role => message.guild.members.me.roles.cache.has(role.id))
    : false;
  const namePattern = /\bredu(?:-chan)?\b/i;

  if (isDirectMention || isRoleMention || namePattern.test(message.content)) {
    const replies = [
      'W-What? It\'s not like I was waiting for you to ping me or anything! What do you want?',
      'Hmph! You\'re always interrupting me... What is it this time?',
      'Ugh, don\'t just call my name so casually, baka! ...But fine, what do you need?',
      'A-Ah! Don\'t startle me like that! ...It\'s not like I mind, but you better have a good reason!',
    ];
    const reply = replies[Math.floor(Math.random() * replies.length)];
    await message.reply(reply);
  }

  // ── Anti-phishing detection (guild-only, image-only) ──
  if (!message.guild) return;

  const imageAttachments = message.attachments.filter(
    att => att.contentType?.startsWith('image/')
  );
  if (imageAttachments.size === 0) return;

  const config = getGuildConfig(message.guild.id);

  // ── SURFACE B: Cross-channel blast detector ────────────────────────────
  for (const [, attachment] of imageAttachments) {
    const fp = attachmentFingerprint(attachment);
    const { triggered, channelCount, sightings } = recordAndCheckBlast(
      message.guild.id,
      message.channel.id,
      message.id,
      fp,
      config
    );

    if (triggered) {
      console.log(
        `[BLAST DETECTED] Fingerprint "${fp}" seen in ${channelCount} channels ` +
        `within ${config.blast_window_ms / 1000}s window. ` +
        `Author: ${message.author.tag} in "${message.guild.name}".`
      );

      // ── Delete ALL blast copies, not just the triggering message ───
      const priorSightings = sightings.filter(s => s.messageId !== message.id);
      if (priorSightings.length > 0) {
        console.log(
          `[BLAST CLEANUP] Deleting ${priorSightings.length} prior blast message(s)...`
        );
        await Promise.allSettled(
          priorSightings.map(async ({ channelId, messageId }) => {
            try {
              const channel = await message.guild.channels.fetch(channelId);
              const msg = await channel.messages.fetch(messageId);
              if (msg.deletable) {
                await msg.delete();
                console.log(
                  `[BLAST CLEANUP] ✓ Deleted prior message ${messageId} ` +
                  `from channel ${channelId}`
                );
              }
            } catch (err) {
              console.warn(
                `[BLAST CLEANUP] ✗ Could not delete message ${messageId} ` +
                `in channel ${channelId}: ${err.message}`
              );
            }
          })
        );
      }

      // Run the standard pipeline on the triggering message.
      await executePunishmentPipeline(message, config.actions, 'Cross-Channel Image Blast');

      // Clear the fingerprint so subsequent channel posts in the same
      // burst don't re-trigger the pipeline a second time.
      blastStore.get(message.guild.id)?.delete(fp);
      return; // skip OCR — punishment already dispatched
    }
  }

  // ── SURFACE A: OCR keyword pipeline ───────────────────────────────────

  const mentionsEveryone = message.content.includes('@everyone');
  const mentionsHere = message.content.includes('@here');
  const mentionsWatchedRole = message.mentions.roles.some(
    role => config.watched_roles.includes(role.id)
  );

  if (!mentionsEveryone && !mentionsHere && !mentionsWatchedRole) return;

  console.log(
    `[OCR TRIGGERED] High-risk mention + image from ${message.author.tag} ` +
    `in "${message.guild.name}" — scanning ${imageAttachments.size} image(s)...`
  );

  try {
    for (const [, attachment] of imageAttachments) {
      const { data: { text } } = await Tesseract.recognize(attachment.url, 'eng', {
        logger: () => {}, // suppress verbose Tesseract progress logs
      });

      const cleanText = text.toLowerCase();
      const matchedKeywords = config.keywords.filter(kw => cleanText.includes(kw));

      console.log(
        `[OCR RESULT] "${attachment.name}": ` +
        `${matchedKeywords.length} hit(s) [${matchedKeywords.join(', ')}]`
      );

      if (matchedKeywords.length >= config.keyword_threshold) {
        console.log(
          `[OCR MATCH] Threshold met (${matchedKeywords.length} >= ` +
          `${config.keyword_threshold}). Triggering pipeline for ${message.author.tag}.`
        );
        await executePunishmentPipeline(message, config.actions, 'OCR Keyword Match');
        break; // one confirmed match per message is sufficient
      }
    }
  } catch (err) {
    console.error(`[ERROR] OCR pipeline error on message ${message.id}:`, err);
  }
});

// ── Punishment pipeline (anti-phishing) ─────────────────────────────────────

/**
 * Sorts active actions by weight (highest first) and executes each one,
 * catching errors per-action so a single failure never aborts the sequence.
 *
 * @param {import('discord.js').Message} message
 * @param {string[]} activeActions
 * @param {string} triggerReason  — logged to console for audit trail
 */
async function executePunishmentPipeline(message, activeActions, triggerReason) {
  const { guild, member, author } = message;

  const sortedActions = [...activeActions].sort(
    (a, b) => (ACTION_WEIGHTS[b] ?? 0) - (ACTION_WEIGHTS[a] ?? 0)
  );

  console.log(
    `[PIPELINE] Reason: "${triggerReason}" | ` +
    `User: ${author.tag} | ` +
    `Sequence: [${sortedActions.join(' → ')}]`
  );

  for (const action of sortedActions) {
    try {
      switch (action) {

        case 'delete':
          if (message.deletable) {
            await message.delete();
            console.log(`[ACTION] ✓ Deleted message (ID: ${message.id})`);
          } else {
            console.warn(`[ACTION] ✗ Message not deletable — missing Manage Messages?`);
          }
          break;

        case 'send_dm':
          try {
            await author.send(
              `⚠️ **Security Alert from ${guild.name}**\n\n` +
              `Your account was flagged for posting a phishing image ` +
              `(detection reason: **${triggerReason}**).\n\n` +
              `**Your account token may be compromised.** A session hijacker ` +
              `may be posting through your account without your knowledge.\n\n` +
              `**Take action immediately:**\n` +
              `1. Go to **User Settings → Privacy & Safety → Change Password**\n` +
              `2. Changing your password invalidates all active sessions\n` +
              `3. Enable **Two-Factor Authentication** if not already active\n\n` +
              `To report this to Discord: https://dis.gd/report`
            );
            console.log(`[ACTION] ✓ Security DM sent to ${author.tag}`);
          } catch {
            console.warn(`[ACTION] ✗ Could not DM ${author.tag} — DMs are closed.`);
          }
          break;

        case 'mute':
          if (member?.moderatable) {
            await member.timeout(24 * 60 * 60 * 1000, `Automated: ${triggerReason}`);
            console.log(`[ACTION] ✓ 24-hour timeout applied to ${author.tag}`);
          } else {
            console.warn(`[ACTION] ✗ Cannot timeout ${author.tag} — not moderatable.`);
          }
          break;

        case 'kick':
          if (member?.kickable) {
            await member.kick(`Automated: ${triggerReason}`);
            console.log(`[ACTION] ✓ Kicked ${author.tag}`);
          } else {
            console.warn(`[ACTION] ✗ Cannot kick ${author.tag} — not kickable.`);
          }
          break;

        case 'ban':
          if (member?.bannable) {
            await guild.members.ban(author.id, {
              reason: `Automated: ${triggerReason}`,
              deleteMessageSeconds: 0,
            });
            console.log(`[ACTION] ✓ Permanently banned ${author.tag}`);
          } else {
            console.warn(`[ACTION] ✗ Cannot ban ${author.tag} — not bannable.`);
          }
          break;

        default:
          console.warn(`[PIPELINE] Unknown action "${action}" — skipping.`);
      }
    } catch (apiErr) {
      console.error(
        `[ACTION ERROR] "${action}" failed for ${author.tag}:`, apiErr.message
      );
    }
  }
}

// ── GitHub polling logic ────────────────────────────────────────────────────

async function pollCommits(client) {
  for (const repo of db.repos) {
    try {
      const { newCommits, latestSHA } = await fetchCommits(repo.owner, repo.repo, repo.lastSHA);

      if (latestSHA && latestSHA !== repo.lastSHA) {
        repo.lastSHA = latestSHA;
        saveDB();
      }

      if (!newCommits.length) continue;

      const channelId = db.channels[`repo_${repo.id}`] || db.channels['global'];
      if (!channelId) continue;

      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel) continue;

      for (const commit of newCommits.reverse()) {
        const embed = buildCommitEmbed(repo, commit);
        await channel.send({ embeds: [embed] });
      }
    } catch (err) {
      console.error(`Error polling ${repo.owner}/${repo.repo}:`, err.message);
    }
  }
}

function buildCommitEmbed(repo, commit) {
  const { sha, commit: c, author, html_url } = commit;
  const shortSHA = sha.slice(0, 7);
  const message = c.message.split('\n')[0]; // first line only
  const body = c.message.split('\n').slice(1).join('\n').trim();
  const authorName = author?.login || c.author.name;
  const authorAvatar = author?.avatar_url;
  const authorURL = author?.html_url;
  const date = new Date(c.author.date);

  const embed = new EmbedBuilder()
    .setColor(0x2DA44E)
    .setAuthor({
      name: `${authorName} pushed to ${repo.owner}/${repo.repo}`,
      iconURL: authorAvatar,
      url: authorURL,
    })
    .setTitle(`\`${shortSHA}\` ${message}`)
    .setURL(html_url)
    .setTimestamp(date);

  if (body) {
    embed.setDescription(`\`\`\`\n${body.slice(0, 500)}\n\`\`\``);
  }

  embed.addFields(
    { name: '🌿 Branch', value: `\`${repo.repo}\``, inline: true },
    { name: '🔑 SHA', value: `[\`${shortSHA}\`](${html_url})`, inline: true },
  );

  return embed;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function parseGitHubURL(url) {
  // Accepts https://github.com/owner/repo or https://github.com/owner/repo.git
  const match = url.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/.*)?$/);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

// ── Start ──────────────────────────────────────────────────────────────────

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('❌ DISCORD_TOKEN environment variable is not set.');
  process.exit(1);
}

client.login(token);
