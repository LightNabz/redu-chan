const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data.json');

const DEFAULT_DB = {
  nextId: 0,
  repos: [],     // { id, owner, repo, url, lastSHA }
  channels: {},  // { "global": channelId, "repo_1": channelId, ... }
};

function loadDB() {
  if (fs.existsSync(DB_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    } catch {
      console.warn('⚠️  Could not parse data.json, starting fresh.');
    }
  }
  return JSON.parse(JSON.stringify(DEFAULT_DB));
}

function saveDB() {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

const db = loadDB();

module.exports = { db, saveDB };
