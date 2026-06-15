require('dotenv').config();

const { Client, GatewayIntentBits, EmbedBuilder, SlashCommandBuilder, REST, Routes } = require('discord.js');
const cron = require('node-cron');
const fs = require('fs');
const { fetchCommits } = require('./github');
const { db, saveDB } = require('./db');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ]
});

// ── Slash command definitions ──────────────────────────────────────────────

const commands = [
  // ── /ping ──
  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check if the bot is alive and see latency info'),

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
            .setRequired(true))),

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
        .setDescription('Show all configured log channels')),
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

    // /logchannel set <#channel>  →  set global fallback
    if (sub === 'set') {
      const channel = interaction.options.getChannel('channel');
      db.channels['global'] = channel.id;
      saveDB();
      return interaction.reply({
        content: `✅ Global log channel set to <#${channel.id}>. All repos without a specific channel will log here.`,
      });
    }

    // /logchannel setrepo <repo_id> <#channel>  →  set repo-specific channel
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

    // /logchannel unsetrepo <repo_id>  →  remove override, fall back to global
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

    // /logchannel list
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
});

// ── Message listener (Redu-chan easter egg) ────────────────────────────────

client.on('messageCreate', async message => {
  if (message.author.bot) return;

  const mentionsBot = message.mentions.has(client.user);
  const content = message.content;
  const namePattern = /\bredu(?:-chan)?\b/i;

  if (mentionsBot || namePattern.test(content)) {
    const replies = [
      'What? do you need anything?',
      'Hmm? Did you call me?',
      'Yes? I\'m here~',
      'You called?',
    ];
    const reply = replies[Math.floor(Math.random() * replies.length)];
    await message.reply(reply);
  }
});

// ── Polling logic ──────────────────────────────────────────────────────────

async function pollCommits(client) {
  for (const repo of db.repos) {
    try {
      const { newCommits, latestSHA } = await fetchCommits(repo.owner, repo.repo, repo.lastSHA);

      // Always persist the latest SHA so the next poll knows where to start
      if (latestSHA && latestSHA !== repo.lastSHA) {
        repo.lastSHA = latestSHA;
        saveDB();
      }

      if (!newCommits.length) continue;

      const channelId = db.channels[`repo_${repo.id}`] || db.channels['global'];
      if (!channelId) continue;

      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel) continue;

      // Send newest-last so they appear chronologically
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
