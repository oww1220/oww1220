import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const token = process.env.GH_STATS_TOKEN;
const isSelfCheck = process.argv.includes('--self-check');
if (!token && !isSelfCheck) {
  throw new Error('GH_STATS_TOKEN is required');
}

const API = 'https://api.github.com';
const OUTPUT_DIR = 'github-stats';
const PER_PAGE = 100;
const CONCURRENCY = 4;

const headers = {
  Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${token}`,
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'oww1220-profile-stats',
};

const nf = new Intl.NumberFormat('en-US');

const COLORS = {
  bg: '#2e3440',
  border: '#eceff4',
  title: '#eceff4',
  text: '#e5e9f0',
  subtext: '#81a1c1',
  muted: '#8fbcbb',
  accent: '#88c0d0',
  accentLine: '#8fbcbb',
  axis: '#d8dee9',
};

const LANGUAGE_COLORS = [
  '#3178c6',
  '#e34c26',
  '#41b883',
  '#f1e05a',
  '#8fbcbb',
  '#b48ead',
  '#d08770',
  '#5e81ac',
];

async function request(path, { allowStatuses = [] } = {}) {
  const response = await fetch(`${API}${path}`, { headers });
  if (!response.ok && !allowStatuses.includes(response.status)) {
    const requestId = response.headers.get('x-github-request-id');
    const requestSuffix = requestId ? `, request ${requestId}` : '';
    throw new Error(`GitHub API request failed (${response.status}${requestSuffix})`);
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

async function countAuthoredCommits(repo, login, options = {}) {
  if (!repo.default_branch) return 0;

  const params = new URLSearchParams({
    sha: repo.default_branch,
    author: login,
    per_page: '1',
    page: '1',
  });

  if (options.since) params.set('since', options.since);
  if (options.until) params.set('until', options.until);

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

function topEntriesWithOther(map, limit = 5) {
  const top = [...map.entries()]
    .filter(([language]) => language !== 'Other')
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit);

  const total = [...map.values()].reduce((sum, value) => sum + value, 0);
  const topTotal = top.reduce((sum, [, value]) => sum + value, 0);
  if (topTotal < total) top.push(['Other', total - topTotal]);

  return top;
}

function formatPercentages(entries, total) {
  let displayedTotal = 0;
  return entries.map(([, value], index) => {
    let percentage = 0;
    if (total > 0) {
      percentage = Number(((value / total) * 100).toFixed(1));
      if (index === entries.length - 1) percentage = 100 - displayedTotal;
    }
    displayedTotal += percentage;
    return percentage.toFixed(1);
  });
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function polarToCartesian(cx, cy, r, angle) {
  const rad = ((angle - 90) * Math.PI) / 180;
  return {
    x: cx + r * Math.cos(rad),
    y: cy + r * Math.sin(rad),
  };
}

function donutSegment(cx, cy, outerR, innerR, startAngle, endAngle, color) {
  const outerStart = polarToCartesian(cx, cy, outerR, endAngle);
  const outerEnd = polarToCartesian(cx, cy, outerR, startAngle);
  const innerStart = polarToCartesian(cx, cy, innerR, endAngle);
  const innerEnd = polarToCartesian(cx, cy, innerR, startAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? '0' : '1';

  return `
    <path
      d="
        M ${outerStart.x.toFixed(3)} ${outerStart.y.toFixed(3)}
        A ${outerR} ${outerR} 0 ${largeArcFlag} 0 ${outerEnd.x.toFixed(3)} ${outerEnd.y.toFixed(3)}
        L ${innerEnd.x.toFixed(3)} ${innerEnd.y.toFixed(3)}
        A ${innerR} ${innerR} 0 ${largeArcFlag} 1 ${innerStart.x.toFixed(3)} ${innerStart.y.toFixed(3)}
        Z
      "
      fill="${color}"
      stroke="${COLORS.bg}"
      stroke-width="2"
    />`;
}

function buildYearRanges(startYear, endYear) {
  return Array.from({ length: endYear - startYear + 1 }, (_, index) => {
    const year = startYear + index;
    return {
      year,
      since: `${year}-01-01T00:00:00Z`,
      until: `${year + 1}-01-01T00:00:00Z`,
    };
  });
}

function niceStep(value) {
  if (value <= 0) return 1;
  const exponent = 10 ** Math.floor(Math.log10(value));
  const fraction = value / exponent;
  let niceFraction;
  if (fraction <= 1) niceFraction = 1;
  else if (fraction <= 2) niceFraction = 2;
  else if (fraction <= 5) niceFraction = 5;
  else niceFraction = 10;
  return niceFraction * exponent;
}

function renderTrendCard({ login, totalCommits, contributedRepos, accessibleRepos, series, startYear, endYear }) {
  const width = 880;
  const height = 280;
  const chartX = 300;
  const chartY = 82;
  const chartWidth = 540;
  const chartHeight = 150;
  const baselineY = chartY + chartHeight;
  const values = series.map((item) => item.count);
  const rawMax = Math.max(...values, 1);
  const step = niceStep(rawMax / 5);
  const maxY = step * 5;
  const ticks = Array.from({ length: 6 }, (_, i) => i * step);

  const points = series.map((item, index) => {
    const x = chartX + (chartWidth / (series.length - 1 || 1)) * index;
    const y = baselineY - (item.count / maxY) * chartHeight;
    return { ...item, x, y };
  });

  const areaPath = [
    `M ${points[0].x.toFixed(2)} ${baselineY.toFixed(2)}`,
    ...points.map((point) => `L ${point.x.toFixed(2)} ${point.y.toFixed(2)}`),
    `L ${points[points.length - 1].x.toFixed(2)} ${baselineY.toFixed(2)}`,
    'Z',
  ].join(' ');

  const linePath = [
    `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`,
    ...points.slice(1).map((point) => `L ${point.x.toFixed(2)} ${point.y.toFixed(2)}`),
  ].join(' ');

  const guides = ticks
    .map((tick) => {
      const y = baselineY - (tick / maxY) * chartHeight;
      return `
        <line x1="${chartX}" y1="${y.toFixed(2)}" x2="${chartX + chartWidth}" y2="${y.toFixed(2)}" stroke="#4c566a" stroke-opacity="0.35" stroke-width="1"/>
        <text x="${chartX + chartWidth + 10}" y="${(y + 4).toFixed(2)}" font-size="11" fill="${COLORS.axis}">${escapeXml(nf.format(tick))}</text>`;
    })
    .join('');

  const xLabels = points
    .map((point) => `
      <line x1="${point.x.toFixed(2)}" y1="${baselineY}" x2="${point.x.toFixed(2)}" y2="${(baselineY + 4).toFixed(2)}" stroke="${COLORS.axis}" stroke-width="1"/>
      <text x="${point.x.toFixed(2)}" y="${(baselineY + 20).toFixed(2)}" text-anchor="middle" font-size="11" fill="${COLORS.axis}">${point.year}</text>`)
    .join('');

  const markers = points
    .map((point) => `
      <circle cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="3.5" fill="${COLORS.accentLine}" stroke="${COLORS.bg}" stroke-width="1.5"/>
      <title>${point.year}: ${nf.format(point.count)} commits</title>`)
    .join('');

  const summaryItems = [
    ['Total actual commits', nf.format(totalCommits)],
    ['Repositories with commits', nf.format(contributedRepos)],
    ['Accessible repos scanned', nf.format(accessibleRepos)],
  ]
    .map(([label, value], index) => {
      const y = 108 + index * 36;
      return `
        <circle cx="38" cy="${y - 5}" r="6" fill="${COLORS.muted}"/>
        <text x="55" y="${y}" font-size="14" fill="${COLORS.text}">${escapeXml(label)}</text>
        <text x="250" y="${y}" text-anchor="end" font-size="14" font-weight="600" fill="${COLORS.axis}">${escapeXml(value)}</text>`;
    })
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <style>text{font-family:'Segoe UI',Ubuntu,'Helvetica Neue',Arial,sans-serif}</style>
    <rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="6" fill="${COLORS.bg}" stroke="${COLORS.border}" stroke-width="1"/>
    <text x="30" y="40" font-size="22" fill="${COLORS.title}">${escapeXml(login)} · Actual Commit Trend</text>
    <text x="30" y="60" font-size="12" fill="${COLORS.subtext}">${startYear}–${endYear} yearly authored commits on accessible repository default branches</text>
    ${summaryItems}
    ${guides}
    <line x1="${chartX}" y1="${baselineY}" x2="${chartX + chartWidth}" y2="${baselineY}" stroke="${COLORS.axis}" stroke-width="1"/>
    <path d="${areaPath}" fill="${COLORS.accent}" fill-opacity="0.82"/>
    <path d="${linePath}" fill="none" stroke="${COLORS.accentLine}" stroke-width="2.5"/>
    ${markers}
    ${xLabels}
  </svg>`;
}

function renderDonutLanguageCard({ title, entries, total, centerValue, centerLabel }) {
  const width = 400;
  const height = 200;
  const cx = 240;
  const chartOffsetX = 60;
  const centerX = cx + chartOffsetX;
  const cy = 120;
  const outerR = 60;
  const innerR = 35;

  let currentAngle = 0;
  const segments = entries
    .map(([language, value], index) => {
      const angle = total > 0 ? (value / total) * 360 : 0;
      const segment = donutSegment(
        cx,
        cy,
        outerR,
        innerR,
        currentAngle,
        currentAngle + angle,
        LANGUAGE_COLORS[index % LANGUAGE_COLORS.length],
      );
      currentAngle += angle;
      return segment;
    })
    .join('');

  const percentages = formatPercentages(entries, total);
  const legends = entries
    .map(([language, value], index) => {
      const y = 70 + index * 22;
      return `
        <rect x="40" y="${y - 12}" width="14" height="14" fill="${LANGUAGE_COLORS[index % LANGUAGE_COLORS.length]}" stroke="${COLORS.bg}"/>
        <text x="58" y="${y}" font-size="13" fill="${COLORS.text}">${escapeXml(language)}</text>
        <text x="158" y="${y}" text-anchor="end" font-size="11" fill="${COLORS.axis}">${escapeXml(nf.format(value))}</text>
        <text x="190" y="${y}" text-anchor="end" font-size="10" fill="${COLORS.muted}">${percentages[index]}%</text>`;
    })
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <style>text{font-family:'Segoe UI',Ubuntu,'Helvetica Neue',Arial,sans-serif}</style>
    <rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="5" fill="${COLORS.bg}" stroke="${COLORS.border}" stroke-width="1"/>
    <text x="30" y="40" font-size="21" fill="${COLORS.title}">${escapeXml(title)}</text>
    ${legends}
    <g transform="translate(${chartOffsetX} 0)">${segments}</g>
    <text x="${centerX}" y="117" text-anchor="middle" font-size="16" font-weight="700" fill="${COLORS.title}">${escapeXml(centerValue)}</text>
    <text x="${centerX}" y="135" text-anchor="middle" font-size="10" fill="${COLORS.subtext}">${escapeXml(centerLabel)}</text>
  </svg>`;
}

if (isSelfCheck) {
  const entries = topEntriesWithOther(new Map([['A', 6], ['B', 5], ['C', 4], ['D', 3], ['E', 2], ['F', 1], ['Other', 2]]));
  assert.deepEqual(entries, [['A', 6], ['B', 5], ['C', 4], ['D', 3], ['E', 2], ['Other', 3]]);
  assert.deepEqual(formatPercentages(entries, 23), ['26.1', '21.7', '17.4', '13.0', '8.7', '13.1']);
  console.log('Self-check passed');
  process.exit(0);
}

const user = await getAuthenticatedUser();
const repos = await listAccessibleRepos();
const startYear = new Date(user.created_at).getUTCFullYear();
const endYear = new Date().getUTCFullYear();
const yearRanges = buildYearRanges(startYear, endYear);

console.log(`Authenticated as ${user.login}`);
console.log(`Accessible repositories: ${repos.length}`);
console.log(`Trend range: ${startYear}-${endYear}`);

const commitResults = await mapLimit(repos, CONCURRENCY, async (repo, index) => {
  const yearlyCounts = [];
  let total = 0;

  for (const range of yearRanges) {
    const count = await countAuthoredCommits(repo, user.login, { since: range.since, until: range.until });
    yearlyCounts.push({ year: range.year, count });
    total += count;
  }

  if ((index + 1) % 10 === 0 || index === repos.length - 1) {
    console.log(`Scanned ${index + 1}/${repos.length} repositories`);
  }

  return { repo, total, yearlyCounts };
});

const contributed = commitResults.filter(({ total }) => total > 0);
const totalCommits = contributed.reduce((sum, { total }) => sum + total, 0);
const repoLanguages = new Map();
const commitLanguages = new Map();
const yearlyTotals = new Map(yearRanges.map((range) => [range.year, 0]));

for (const { repo, total, yearlyCounts } of contributed) {
  const language = repo.language || 'Other';
  increment(repoLanguages, language, 1);
  increment(commitLanguages, language, total);

  for (const item of yearlyCounts) {
    increment(yearlyTotals, item.year, item.count);
  }
}

const series = yearRanges.map((range) => ({ year: range.year, count: yearlyTotals.get(range.year) ?? 0 }));
const repoLanguageTop = topEntriesWithOther(repoLanguages);
const commitLanguageTop = topEntriesWithOther(commitLanguages);
const repoLanguageTotal = [...repoLanguages.values()].reduce((a, b) => a + b, 0);
const commitLanguageTotal = [...commitLanguages.values()].reduce((a, b) => a + b, 0);

await mkdir(OUTPUT_DIR, { recursive: true });
await writeFile(
  `${OUTPUT_DIR}/commit-trend.svg`,
  renderTrendCard({
    login: user.login,
    totalCommits,
    contributedRepos: contributed.length,
    accessibleRepos: repos.length,
    series,
    startYear,
    endYear,
  }),
  'utf8',
);
await writeFile(
  `${OUTPUT_DIR}/top-languages-by-repo.svg`,
  renderDonutLanguageCard({
    title: 'Top Languages by Repo',
    entries: repoLanguageTop,
    total: repoLanguageTotal,
    centerValue: nf.format(repoLanguageTotal),
    centerLabel: 'repos',
  }),
  'utf8',
);
await writeFile(
  `${OUTPUT_DIR}/top-languages-by-commit.svg`,
  renderDonutLanguageCard({
    title: 'Top Languages by Commit',
    entries: commitLanguageTop,
    total: commitLanguageTotal,
    centerValue: totalCommits >= 1000 ? `${(totalCommits / 1000).toFixed(2)}K` : nf.format(totalCommits),
    centerLabel: 'commits',
  }),
  'utf8',
);

console.log(`Actual commits: ${totalCommits}`);
console.log(`Repositories with authored commits: ${contributed.length}`);
console.log(`Top repo languages: ${JSON.stringify(repoLanguageTop)}`);
console.log(`Top commit languages: ${JSON.stringify(commitLanguageTop)}`);
console.log(`Yearly trend: ${JSON.stringify(series)}`);
