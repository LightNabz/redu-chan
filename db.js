const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data.json');

const DEFAULT_KEYWORDS = Object.freeze([
  'mr. beast',
  'mrbeast',
  'promo code',
  'dasowin',
  'giveaway',
  'claim',
  'deposit',
]);

function defaultGuildDB() {
  return {
    nextId: 0,
    repos: [],     // { id, owner, repo, url, lastSHA }
    channels: {},  // { "global": channelId, "repo_1": channelId, ... }
  };
}

function defaultPhishingConfig() {
  return {
    watched_roles: [],
    actions: ['delete', 'send_dm', 'mute'],
    keywords: [...DEFAULT_KEYWORDS],
    keyword_threshold: 2,
    blast_channels: 3,
    blast_window_ms: 60_000,
    log_channel: null,
  };
}

/**
 * Loads data.json. Transparently migrates the old single-server shape
 * ({ nextId, repos, channels }) into the new multi-server shape
 * ({ guilds: { [guildId]: { nextId, repos, channels } } }).
 *
 * Legacy data is migrated into whichever guild is set via the GUILD_ID
 * env var, since that's the server the bot was previously being run
 * for. If GUILD_ID isn't set, the legacy data is preserved untouched
 * on disk (nothing is deleted) but not loaded, and a warning is logged
 * so nothing is silently lost.
 */
function loadDB() {
  if (fs.existsSync(DB_PATH)) {
    try {
      const raw = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));

      // Already in multi-guild shape.
      if (raw.guilds) {
        if (!raw.phishing) raw.phishing = {};
        return raw;
      }

      // Legacy single-guild shape — migrate.
      if (Array.isArray(raw.repos)) {
        const migrateGuildId = process.env.GUILD_ID;

        if (migrateGuildId) {
          console.warn(
            `⚠️  Legacy single-server data.json detected. Migrating ${raw.repos.length} ` +
            `repo(s) into multi-server format under guild ${migrateGuildId} (from GUILD_ID env var).`
          );
          const migrated = {
            guilds: {
              [migrateGuildId]: {
                nextId: raw.nextId ?? 0,
                repos: raw.repos ?? [],
                channels: raw.channels ?? {},
              },
            },
            phishing: {},
          };
          // Persist immediately so the legacy shape isn't re-migrated on every boot.
          fs.writeFileSync(DB_PATH, JSON.stringify(migrated, null, 2));
          return migrated;
        }

        console.warn(
          '⚠️  Legacy single-server data.json detected but no GUILD_ID env var is set, ' +
          'so it cannot be auto-assigned to a specific server. Starting empty instead — ' +
          'your old data is still on disk under the legacy keys. Set GUILD_ID in .env to ' +
          'the server it belongs to and restart to auto-migrate it.'
        );
        return { guilds: {}, phishing: {} };
      }
    } catch {
      console.warn('⚠️  Could not parse data.json, starting fresh.');
    }
  }
  return { guilds: {}, phishing: {} };
}

function saveDB() {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

const db = loadDB();

/**
 * Returns (and lazily creates) the per-guild data slice.
 * @param {string} guildId
 */
function getGuildDB(guildId) {
  if (!db.guilds[guildId]) {
    db.guilds[guildId] = defaultGuildDB();
  }
  return db.guilds[guildId];
}

/**
 * Returns (and lazily creates) the per-guild anti-phishing config slice.
 * @param {string} guildId
 */
function getPhishingConfig(guildId) {
  if (!db.phishing[guildId]) {
    db.phishing[guildId] = defaultPhishingConfig();
  }
  return db.phishing[guildId];
}

module.exports = { db, saveDB, getGuildDB, getPhishingConfig };

