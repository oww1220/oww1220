import { mkdir, writeFile } from 'node:fs/promises';

const token = process.env.GH_STATS_TOKEN;
if (!token) {
  throw new Error('GH_STATS_TOKEN is required');
}

const API = 'https://api.github.com';
const OUTPUT_DIR = 'github-stats';
const PER_PAGE = 100;
const CONCURRENCY = 6;

const THEME = {
  bg: '#2e3440',
  panel: '#3b4252',
  border: '#eceff4',
  title: '#eceff4',
  text: '#e5e9f0',
  subtext: '#d8dee9',
  accent: '#88c0d0',
  accent2: '#8fbcbb',
  muted: '#81a1c1',
};

const LANGUAGE_COLORS = {
  TypeScript: '#3178c6',
  HTML: '#e34c26',
  Vue: '#41b883',
  JavaScript: '#f1e05a',
  SCSS: '#c6538c',
  CSS: '#563d7c',
  EJS: '#a91e50',
  Java: '#b07219',
  Python: '#3572A5',
  Shell: '#89e051',
  Kotlin: '#A97BFF',
  PHP: '#4F5D95',
  Other: '#8fbcbb',
};

const FALLBACK_COLORS = ['#88c0d0', '#81a1c1', '#8fbcbb', '#b48ead', '#d08770'];

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

function compactNumber(value) {
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 2,
  }).format(value);
}

function languageColor(language, index) {
  return LANGUAGE_COLORS[language] ?? FALLBACK_COLORS[index % FALLBACK_COLORS.length];
}

function polarToCartesian(cx, cy, radius, angle) {
  const radians = ((angle - 90) * Math.PI) / 180;
  return {
    x: cx + radius * Math.cos(radians),
    y: cy + radius * Math.sin(radians),
  };
}

function donutPath(cx, cy, outerRadius, innerRadius, startAngle, endAngle) {
  const safeEnd = Math.min(endAngle, startAngle + 359.8);
  const outerStart = polarToCartesian(cx, cy, outerRadius, safeEnd);
  const outerEnd = polarToCartesian(cx, cy, outerRadius, startAngle);
  const innerStart = polarToCartesian(cx, cy, innerRadius, safeEnd);
  const innerEnd = polarToCartesian(cx, cy, innerRadius, startAngle);
  const largeArc = safeEnd - startAngle > 180 ? 1 : 0;

  return [
    `M ${outerStart.x.toFixed(3)} ${outerStart.y.toFixed(3)}`,
    `A ${outerRadius} ${outerRadius} 0 ${largeArc} 0 ${outerEnd.x.toFixed(3)} ${outerEnd.y.toFixed(3)}`,
    `L ${innerEnd.x.toFixed(3)} ${innerEnd.y.toFixed(3)}`,
    `A ${innerRadius} ${innerRadius} 0 ${largeArc} 1 ${innerStart.x.toFixed(3)} ${innerStart.y.toFixed(3)}`,
    'Z',
  ].join(' ');
}

function renderStats({ login, totalCommits, contributedRepos, accessibleRepos }) {
  const rows = [
    ['Actual commits', nf.format(totalCommits)],
    ['Repos with commits', nf.format(contributedRepos)],
    ['Accessible repos scanned', nf.format(accessibleRepos)],
  ];

  const rowMarkup = rows
    .map(([label, value], index) => {
      const y = 82 + index * 32;
      return `
        <circle cx="38" cy="${y - 5}" r="6" fill="${THEME.accent2}"/>
        <text x="55" y="${y}" font-size="14" fill="${THEME.text}">${escapeXml(label)}</text>
        <text x="250" y="${y}" text-anchor="end" font-size="14" font-weight="600" fill="${THEME.subtext}">${escapeXml(value)}</text>`;
    })
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="700" height="200" viewBox="0 0 700 200">
    <style>text{font-family:'Segoe UI',Ubuntu,'Helvetica Neue',Arial,sans-serif}</style>
    <rect x="1" y="1" width="698" height="198" rx="5" fill="${THEME.bg}" stroke="${THEME.border}" stroke-width="1"/>
    <text x="30" y="40" font-size="22" fill="${THEME.title}">${escapeXml(login)} · Actual Git Activity</text>

    <g transform="translate(0,18)">
      ${rowMarkup}
    </g>

    <g transform="translate(330,38)">
      <rect x="0" y="0" width="330" height="126" rx="5" fill="${THEME.panel}" opacity="0.45"/>
      <text x="165" y="55" text-anchor="middle" font-size="38" font-weight="700" fill="${THEME.accent}">${escapeXml(compactNumber(totalCommits))}</text>
      <text x="165" y="79" text-anchor="middle" font-size="13" fill="${THEME.text}">actual authored commits</text>
      <text x="165" y="101" text-anchor="middle" font-size="11" fill="${THEME.muted}">accessible repository default branches</text>
    </g>

    <text x="30" y="183" font-size="10" fill="${THEME.accent2}">Private repository names and commit messages are never rendered.</text>
  </svg>`;
}

function renderLanguageCard({ title, entries, total, unit }) {
  const width = 340;
  const height = 200;
  const cx = 240;
  const cy = 120;
  const outerRadius = 60;
  const innerRadius = 35;

  let angle = 0;
  const segments = entries
    .map(([language, value], index) => {
      const ratio = total > 0 ? value / total : 0;
      const next = angle + ratio * 360;
      const path = donutPath(cx, cy, outerRadius, innerRadius, angle, next);
      const color = languageColor(language, index);
      angle = next;
      return `<path d="${path}" fill="${color}" stroke="${THEME.bg}" stroke-width="2"/>`;
    })
    .join('');

  const legend = entries
    .map(([language, value], index) => {
      const y = 78 + index * 25;
      const color = languageColor(language, index);
      const percent = total > 0 ? ((value / total) * 100).toFixed(1) : '0.0';
      return `
        <rect x="40" y="${y - 12}" width="14" height="14" fill="${color}" stroke="${THEME.bg}"/>
        <text x="58" y="${y}" font-size="13" fill="${THEME.text}">${escapeXml(language)}</text>
        <text x="158" y="${y}" text-anchor="end" font-size="11" fill="${THEME.subtext}">${escapeXml(nf.format(value))}</text>
        <text x="190" y="${y}" text-anchor="end" font-size="10" fill="${THEME.accent2}">${percent}%</text>`;
    })
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <style>text{font-family:'Segoe UI',Ubuntu,'Helvetica Neue',Arial,sans-serif}</style>
    <rect x="1" y="1" width="338" height="198" rx="5" fill="${THEME.bg}" stroke="${THEME.border}" stroke-width="1"/>
    <text x="30" y="40" font-size="21" fill="${THEME.title}">${escapeXml(title)}</text>

    ${legend}

    <g>${segments}</g>
    <text x="${cx}" y="${cy - 3}" text-anchor="middle" font-size="16" font-weight="700" fill="${THEME.title}">${escapeXml(compactNumber(total))}</text>
    <text x="${cx}" y="${cy + 15}" text-anchor="middle" font-size="10" fill="${THEME.muted}">${escapeXml(unit)}</text>
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
