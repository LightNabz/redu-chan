const https = require('https');

/**
 * Fetch commits from GitHub API since the last seen SHA.
 * Returns { newCommits, latestSHA }
 *   - newCommits: array of commit objects newer than lastSHA (newest first)
 *   - latestSHA:  the SHA of the most recent commit (should always be saved)
 *
 * On first call (lastSHA = null), newCommits is [] so we don't flood the
 * channel with history, but latestSHA is still returned so future polls work.
 */
async function fetchCommits(owner, repo, lastSHA = null) {
  const token = process.env.GITHUB_TOKEN;
  const headers = {
    'User-Agent': 'discord-git-bot/1.0',
    'Accept': 'application/vnd.github+json',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const url = `https://api.github.com/repos/${owner}/${repo}/commits?per_page=10`;
  const commits = await get(url, headers);

  if (!Array.isArray(commits)) {
    const msg = commits?.message || 'Unknown GitHub API error';
    throw new Error(`GitHub API: ${msg}`);
  }

  if (!commits.length) {
    return { newCommits: [], latestSHA: lastSHA };
  }

  const latestSHA = commits[0].sha;

  if (!lastSHA) {
    // First poll — record latest SHA but don't post historical commits
    return { newCommits: [], latestSHA };
  }

  if (lastSHA === latestSHA) {
    // Nothing new since last poll
    return { newCommits: [], latestSHA };
  }

  // Collect only commits newer than lastSHA
  const newCommits = [];
  for (const c of commits) {
    if (c.sha === lastSHA) break;
    newCommits.push(c);
  }

  return { newCommits, latestSHA };
}

function get(url, headers) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, res => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Failed to parse GitHub response'));
        }
      });
    }).on('error', reject);
  });
}

module.exports = { fetchCommits };
