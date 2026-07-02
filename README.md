# Redu-chan 🤖

A single Discord bot that does two unrelated jobs well:

1. **GitHub Commit Tracker** — polls repos and posts new commits to a channel.
2. **Anti-Phishing Detector** — deletes and punishes accounts posting scam images, using both OCR keyword scanning and cross-channel blast detection.

Both features are fully multi-server: every setting (tracked repos, log channels, watched roles, keywords, punishment actions) is stored per-guild, so running the bot in multiple servers keeps each server's configuration completely separate.

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

Create a `.env` file in the project root:

```env
DISCORD_TOKEN=your_discord_bot_token_here
GUILD_ID=your_dev_server_id_here          # optional, see note below
GITHUB_TOKEN=your_github_pat_here         # optional, raises rate limit from 60 to 5000 req/hr
```

**Never commit `.env` or paste your token anywhere public.** If a token is ever exposed, regenerate it immediately in the Developer Portal (**Bot → Reset Token**) — anyone with it has full control of the bot.

`GUILD_ID` is optional and only affects *how fast* slash commands appear:
- Commands are always registered **globally**, reaching every server the bot is in (can take up to ~1 hour to propagate).
- If `GUILD_ID` is set, commands are **additionally** registered directly to that one server, where they appear instantly — useful for actively developing/testing commands without waiting on global propagation.

### 4. Discord bot permissions

In the [Discord Developer Portal](https://discord.com/developers/applications):

**OAuth2 scopes:** `bot`, `applications.commands`

**Bot permissions:**

| Permission | Used for |
|---|---|
| View Channels | Reading messages/attachments, fetching channels |
| Send Messages | Commit embeds, phishing alerts, easter-egg replies |
| Embed Links | Every bot response uses rich embeds |
| Read Message History | Fetching/deleting prior copies of a blasted image across channels |
| Manage Messages | Deleting phishing messages |
| Timeout Members | The `mute` punishment action |
| Kick Members | The `kick` punishment action |
| Ban Members | The `ban` punishment action |

**Privileged Gateway Intents** (Developer Portal → Bot → Privileged Gateway Intents — separate from the invite link):
- **Message Content Intent** — required to read message text for keyword/mention detection and the easter egg
- **Server Members Intent** — required to resolve member permissions before mute/kick/ban

Ready-made invite link (replace `YOUR_CLIENT_ID`):
```
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot+applications.commands&permissions=1099511720966
```

### 5. Run
```bash
node index.js
```

---

## Feature 1 — GitHub Commit Tracker

### Commands

| Command | Description |
|---|---|
| `/repo add <url>` | Track a GitHub repo (e.g. `https://github.com/owner/repo`) |
| `/repo list` | List tracked repos with their IDs and assigned channels |
| `/repo remove <id>` | Stop tracking a repo by its ID |
| `/logchannel set <#channel>` | Set the **global** fallback log channel for all repos |
| `/logchannel setrepo <repo_id> <#channel>` | Set a **repo-specific** log channel |
| `/logchannel unsetrepo <repo_id>` | Remove a repo-specific channel, falling back to global |
| `/logchannel list` | Show all configured log channels |
| `/ping` | Health check — latency and repo count for the current server |

### How it works

1. Add repos with `/repo add`. Each repo gets a numeric ID (scoped to that server — repo `#1` in Server A is unrelated to `#1` in Server B).
2. Assign log channels — a global catch-all, per-repo overrides, or both.
3. Every **5 minutes**, the bot polls each repo's GitHub API for new commits.
4. New commits post as rich embeds: author, commit message, SHA, timestamp, and a link to the diff.

> The bot records the latest SHA on first poll but does **not** post historical commits — only new ones from that point forward.

### Rate limits

- Without a GitHub token: **60 requests/hour** across all repos, all servers combined
- With a GitHub PAT: **5,000 requests/hour**

At 5-minute polling intervals, a PAT comfortably supports tracking **~400 repos** total.

---

## Feature 2 — Anti-Phishing Detector

Scam bots typically compromise an account and post the same scam image in bulk across many channels, often tagging `@everyone`/`@here` or a large role. This bot catches that pattern two different ways:

### Surface A — OCR Keyword Pipeline (mention-gated)
Fires when a message contains a high-risk mention (`@everyone`, `@here`, or a watched role) **and** an image attachment. The image is OCR'd (Tesseract) and scanned against the server's keyword list. Triggers the punishment pipeline once keyword hits meet the configured threshold.

### Surface B — Cross-Channel Image Blast Detection (mention-free)
Catches bots that post silently with no mentions at all. Every image is fingerprinted (filename + byte size) and tracked in a short-lived velocity store. If the *same* image appears in enough distinct channels within a rolling time window, the bot runs OCR on it as a confirmation check — only proceeding to punishment if the image also matches enough scam keywords. This prevents ordinary users who post the same image to a few channels (memes, announcements, excitement) from being punished; only images that are both *fast-spreading* and *confirmed scam content* trigger action.

### Commands

| Command | Description |
|---|---|
| `/watch add <role>` | Add a role to the high-risk mention watch list (`@everyone`/`@here` always watched) |
| `/watch remove <role>` | Remove a role from the watch list |
| `/watchlist` | Show currently watched roles |
| `/action add <type>` | Add a punishment to the pipeline: `delete`, `send_dm`, `mute`, `kick`, `ban` |
| `/action remove <type>` | Remove a punishment from the pipeline |
| `/action list` | Show active punishments in execution order |
| `/keywords add <word>` | Add a scam keyword/phrase (case-insensitive) |
| `/keywords remove <word>` | Remove a keyword |
| `/keywords list` | Show all active keywords and the current match threshold |
| `/phishconfig log-channel <#channel>` | Set where phishing detections are logged |
| `/phishconfig blast-threshold <channels> <seconds>` | Tune the cross-channel blast trigger (default: 3 channels / 60s) |
| `/phishconfig keyword-threshold <count>` | Set minimum OCR keyword hits required to trigger (default: 2) |

### Punishment pipeline

Active actions run in a fixed priority order regardless of the order they were added, so the message is gone before further steps run:

| Action | Weight | Effect |
|---|---|---|
| `delete` | 100 | Deletes the offending message immediately |
| `send_dm` | 80 | DMs the account a security alert recommending a password reset |
| `mute` | 50 | 24-hour timeout |
| `kick` | 20 | Removes the account from the server |
| `ban` | 10 | Permanently bans the account |

Each action fails gracefully and independently — e.g. if the bot can't DM a user (DMs closed), it logs a warning and continues with the rest of the pipeline rather than aborting.

Every confirmed detection (from either surface) is posted as an embed to the configured `log-channel`, showing the user, trigger reason, actions taken, and the originating channel.

### Default keywords

`mr. beast`, `mrbeast`, `promo code`, `dasowin`, `giveaway`, `claim`, `deposit` — customize freely with `/keywords add`/`remove` per server.

---

## Data storage & multi-server persistence

All state — tracked repos, log channels, and every anti-phishing setting — is stored in `data.json` in the project root, keyed per Discord server (guild ID). Nothing is held only in memory, so restarting the bot does **not** reset any server's configuration.

```json
{
  "guilds": {
    "<guildId>": { "nextId": 0, "repos": [...], "channels": {...} }
  },
  "phishing": {
    "<guildId>": {
      "watched_roles": [...],
      "actions": [...],
      "keywords": [...],
      "keyword_threshold": 2,
      "blast_channels": 3,
      "blast_window_ms": 60000,
      "log_channel": "..."
    }
  }
}
```

You can safely back this file up or commit it (it contains channel/role IDs, not secrets).

> **Upgrading from an older single-server version?** The bot auto-detects the legacy flat `data.json` shape on first boot and migrates it into the new per-guild format under whatever `GUILD_ID` is set in `.env`. If `GUILD_ID` isn't set at migration time, it starts empty instead of guessing — your old data stays untouched on disk until you set `GUILD_ID` and restart.

---

## Easter egg

Mentioning the bot, saying "redu" or "redu-chan" in a message, or mentioning a role the bot has gets a random in-character reply. Purely cosmetic — has no effect on either feature above.
