# Discord Git Bot 🤖

A Discord bot that polls GitHub repositories and logs new commits to designated channels.

---

## Setup

### 1. Prerequisites
- Node.js 18+
- A Discord bot token
- (Optional but recommended) A GitHub personal access token

### 2. Install dependencies
```bash
npm install
```

### 3. Environment variables

Create a `.env` file or export these before running:

```env
DISCORD_TOKEN=your_discord_bot_token_here
GITHUB_TOKEN=your_github_pat_here        # optional, raises rate limit from 60 to 5000 req/hr
```

To load `.env` automatically, install dotenv:
```bash
npm install dotenv
```
Then add this as the very first line of `index.js`:
```js
require('dotenv').config();
```

### 4. Discord bot permissions

In the [Discord Developer Portal](https://discord.com/developers/applications):
- Enable **Bot** and add these scopes: `bot`, `applications.commands`
- Bot permissions needed: **Send Messages**, **Embed Links**, **View Channels**

### 5. Run
```bash
node index.js
```

---

## Commands

| Command | Description |
|---|---|
| `/repo add <url>` | Track a GitHub repo (e.g. `https://github.com/owner/repo`) |
| `/repo list` | List all tracked repos with their IDs and assigned channels |
| `/repo remove <id>` | Stop tracking a repo by its ID |
| `/logchannel set <#channel>` | Set the **global** fallback log channel for all repos |
| `/logchannel set <#channel> <repo_id>` | Set a **repo-specific** log channel |
| `/logchannel list` | Show all configured log channels |

---

## How it works

1. You add repos with `/repo add`. Each repo gets a numeric ID.
2. You assign log channels — either a global catch-all or per-repo overrides.
3. Every **5 minutes**, the bot polls each repo's GitHub API for new commits.
4. New commits are posted as rich embeds showing: author, commit message, SHA, timestamp, and a link to the diff.

> **Note:** The bot records the latest SHA on first poll but does **not** post historical commits — only new ones from that point forward.

---

## Commit log format

Each commit appears as a Discord embed:

```
👤 username pushed to owner/repo
`a1b2c3d` Fix crash when input is empty
─────────────────────────────────
🌿 Branch   repo-name
🔑 SHA      a1b2c3d  (links to GitHub)
                     [timestamp]
```

Multi-line commit bodies are shown in a code block (truncated at 500 chars).

---

## Data storage

All data (repos, channel assignments, last seen SHAs) is stored in `data.json` in the project root. You can safely back this file up or commit it.

---

## Rate limits

- Without a GitHub token: **60 requests/hour** across all repos
- With a GitHub PAT: **5,000 requests/hour**

At 5-minute polling intervals, you can comfortably track up to **~400 repos** with a PAT.
