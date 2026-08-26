import { mkdir, writeFile } from 'node:fs/promises';

const token = process.env.GH_STATS_TOKEN;
if (!token) {
  throw new Error('GH_STATS_TOKEN is required');
}

const API = 'https://api.github.com';
const OUTPUT_DIR = 'github-stats';
const PER_PAGE = 100;
const CONCURRENCY = 6;

const headers = {
  Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${token}`,
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'oww1220-profile-stats',
};

async function request(path, { allowStatuses = [] } = {}) {
  const response = await fetch(`${API}${path}`, { headers });
  if (!response.ok && !allowStatuses.includes(response.status)) {
    const body = await response.text();
    throw new Error(`GitHub API ${response.status} ${path}: ${body.slice(0, 500)}`);
  }
  return response;
}

async function getAuthenticatedUser() {
  const response = await request('/user');
  return response.json();
}

async function listAccessibleRepos() {
  const repos = [];
  for (let page = 1; ; page += 1) {
    const params = new URLSearchParams({
      visibility: 'all',
      affiliation: 'owner,collaborator,organization_member',
      sort: 'full_name',
      direction: 'asc',
      per_page: String(PER_PAGE),
      page: String(page),
    });
    const response = await request(`/user/repos?${params}`);
    const batch = await response.json();
    repos.push(...batch);
    if (batch.length < PER_PAGE) break;
  }
  return repos;
}

function parseLastPage(linkHeader) {
  if (!linkHeader) return null;
  const match = linkHeader.match(/[?&]page=(\d+)[^>]*>; rel="last"/);
  return match ? Number(match[1]) : null;
}

async function countAuthoredCommits(repo, login) {
  if (!repo.default_branch) return 0;

  const params = new URLSearchParams({
    sha: repo.default_branch,
    author: login,
    per_page: '1',
    page: '1',
  });

  const response = await request(
    `/repos/${encodeURIComponent(repo.owner.login)}/${encodeURIComponent(repo.name)}/commits?${params}`,
    { allowStatuses: [404, 409, 422] },
  );

  if (!response.ok) return 0;
  const commits = await response.json();
  if (!Array.isArray(commits) || commits.length === 0) return 0;

  const lastPage = parseLastPage(response.headers.get('link'));
  return lastPage ?? commits.length;
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

function increment(map, key, value = 1) {
  map.set(key, (map.get(key) ?? 0) + value);
}

function topEntries(map, limit = 5) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit);
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

const nf = new Intl.NumberFormat('en-US');

function renderStats({ login, totalCommits, contributedRepos, accessibleRepos }) {
  const width = 700;
  const height = 190;
  const cards = [
    ['Actual commits', nf.format(totalCommits)],
    ['Repos with commits', nf.format(contributedRepos)],
    ['Accessible repos scanned', nf.format(accessibleRepos)],
  ];

  const cellWidth = 205;
  const startX = 30;
  const gap = 15;

  const cells = cards
    .map(([label, value], i) => {
      const x = startX + i * (cellWidth + gap);
      return `
        <g transform="translate(${x},70)">
          <rect width="${cellWidth}" height="70" rx="6" fill="#3b4252"/>
          <text x="14" y="26" font-size="13" fill="#d8dee9">${escapeXml(label)}</text>
          <text x="14" y="54" font-size="24" font-weight="700" fill="#88c0d0">${escapeXml(value)}</text>
        </g>`;
    })
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <style>text{font-family:'Segoe UI',Ubuntu,'Helvetica Neue',Arial,sans-serif}</style>
    <rect x="1" y="1" width="698" height="188" rx="6" fill="#2e3440" stroke="#eceff4"/>
    <text x="30" y="38" font-size="22" font-weight="700" fill="#eceff4">Actual Git Activity</text>
    <text x="30" y="57" font-size="11" fill="#81a1c1">authored commits on accessible repository default branches · ${escapeXml(login)}</text>
    ${cells}
    <text x="30" y="170" font-size="10" fill="#8fbcbb">Private repository names and commit messages are never rendered.</text>
  </svg>`;
}

function renderLanguageCard({ title, subtitle, entries, total, unit }) {
  const width = 340;
  const height = 230;
  const max = Math.max(...entries.map(([, value]) => value), 1);
  const barWidth = 130;

  const rows = entries
    .map(([language, value], i) => {
      const y = 82 + i * 27;
      const widthValue = Math.max(3, Math.round((value / max) * barWidth));
      const percentage = total > 0 ? ((value / total) * 100).toFixed(1) : '0.0';
      return `
        <text x="24" y="${y}" font-size="12" fill="#e5e9f0">${escapeXml(language)}</text>
        <rect x="112" y="${y - 11}" width="${barWidth}" height="10" rx="3" fill="#3b4252"/>
        <rect x="112" y="${y - 11}" width="${widthValue}" height="10" rx="3" fill="#88c0d0"/>
        <text x="252" y="${y}" font-size="11" fill="#d8dee9">${escapeXml(nf.format(value))} ${escapeXml(unit)}</text>
        <text x="316" y="${y}" text-anchor="end" font-size="10" fill="#8fbcbb">${percentage}%</text>`;
    })
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <style>text{font-family:'Segoe UI',Ubuntu,'Helvetica Neue',Arial,sans-serif}</style>
    <rect x="1" y="1" width="338" height="228" rx="6" fill="#2e3440" stroke="#eceff4"/>
    <text x="24" y="36" font-size="20" font-weight="700" fill="#eceff4">${escapeXml(title)}</text>
    <text x="24" y="55" font-size="10" fill="#81a1c1">${escapeXml(subtitle)}</text>
    ${rows}
  </svg>`;
}

const user = await getAuthenticatedUser();
const repos = await listAccessibleRepos();

console.log(`Authenticated as ${user.login}`);
console.log(`Accessible repositories: ${repos.length}`);

const commitResults = await mapLimit(repos, CONCURRENCY, async (repo, index) => {
  const count = await countAuthoredCommits(repo, user.login);
  if ((index + 1) % 20 === 0 || index === repos.length - 1) {
    console.log(`Scanned ${index + 1}/${repos.length} repositories`);
  }
  return { repo, count };
});

const contributed = commitResults.filter(({ count }) => count > 0);
const totalCommits = contributed.reduce((sum, { count }) => sum + count, 0);
const repoLanguages = new Map();
const commitLanguages = new Map();

for (const { repo, count } of contributed) {
  const language = repo.language || 'Other';
  increment(repoLanguages, language, 1);
  increment(commitLanguages, language, count);
}

const repoLanguageTop = topEntries(repoLanguages);
const commitLanguageTop = topEntries(commitLanguages);
const repoLanguageTotal = [...repoLanguages.values()].reduce((a, b) => a + b, 0);
const commitLanguageTotal = [...commitLanguages.values()].reduce((a, b) => a + b, 0);

await mkdir(OUTPUT_DIR, { recursive: true });
await writeFile(
  `${OUTPUT_DIR}/actual-stats.svg`,
  renderStats({
    login: user.login,
    totalCommits,
    contributedRepos: contributed.length,
    accessibleRepos: repos.length,
  }),
  'utf8',
);
await writeFile(
  `${OUTPUT_DIR}/top-languages-by-repo.svg`,
  renderLanguageCard({
    title: 'Top Languages by Repo',
    subtitle: 'primary language of repositories containing your commits',
    entries: repoLanguageTop,
    total: repoLanguageTotal,
    unit: 'repos',
  }),
  'utf8',
);
await writeFile(
  `${OUTPUT_DIR}/top-languages-by-commit.svg`,
  renderLanguageCard({
    title: 'Top Languages by Commit',
    subtitle: 'your actual commit count grouped by repository primary language',
    entries: commitLanguageTop,
    total: commitLanguageTotal,
    unit: 'commits',
  }),
  'utf8',
);

console.log(`Actual commits: ${totalCommits}`);
console.log(`Repositories with authored commits: ${contributed.length}`);
console.log(`Top repo languages: ${JSON.stringify(repoLanguageTop)}`);
console.log(`Top commit languages: ${JSON.stringify(commitLanguageTop)}`);
