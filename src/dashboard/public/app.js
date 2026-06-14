/**
 * Dashboard client-side application.
 *
 * Hash-based client-side routing over a single index.html:
 *   #/                                          -> repo list (M3)
 *   #/repos/<encoded-path>                      -> repo summary (M4)
 *   #/repos/<encoded-path>/files/<encoded-file> -> file drill-down (M5)
 *
 * All data comes from the read-only /api/* endpoints. The Refresh button
 * (M6) simply re-runs the current route's render function.
 */

const ISSUE_TYPES = ['BUG', 'VULNERABILITY', 'CODE_SMELL', 'SECURITY_HOTSPOT'];
const ISSUE_SEVERITIES = ['BLOCKER', 'CRITICAL', 'MAJOR', 'MINOR', 'INFO'];

const appEl = document.getElementById('app');
const refreshBtn = document.getElementById('refresh-btn');

/** Tracks the active Chart.js instances so they can be destroyed on re-render. */
let activeCharts = [];

function destroyCharts() {
  for (const chart of activeCharts) {
    chart.destroy();
  }
  activeCharts = [];
}

/** Escape a string for safe insertion into innerHTML. */
function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = String(value);
  return div.innerHTML;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const error = new Error(body.error || `Request failed: ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/** Parses the current location hash into a route descriptor. */
function parseRoute() {
  const hash = window.location.hash.replace(/^#/, '') || '/';
  const segments = hash.split('/').filter((s) => s.length > 0);

  if (segments.length === 0) {
    return { view: 'list' };
  }

  if (segments[0] === 'repos' && segments.length >= 2) {
    const repoPath = decodeURIComponent(segments[1]);

    if (segments.length === 2) {
      return { view: 'summary', repoPath };
    }

    if (segments[2] === 'files' && segments.length >= 4) {
      const filePath = segments
        .slice(3)
        .map((s) => decodeURIComponent(s))
        .join('/');
      return { view: 'file', repoPath, filePath };
    }
  }

  return { view: 'unknown' };
}

/** Renders the view for the current route. */
async function render() {
  destroyCharts();
  const route = parseRoute();

  try {
    if (route.view === 'list') {
      await renderRepoList();
    } else if (route.view === 'summary') {
      await renderRepoSummary(route.repoPath);
    } else if (route.view === 'file') {
      await renderFileDrilldown(route.repoPath, route.filePath);
    } else {
      appEl.innerHTML = '<div class="error-state">Unknown route.</div>';
    }
  } catch (error) {
    appEl.innerHTML = `<div class="error-state">Error: ${escapeHtml(error.message)}</div>`;
  }
}

window.addEventListener('hashchange', render);
document.addEventListener('DOMContentLoaded', render);
refreshBtn.addEventListener('click', render);

// ---------------------------------------------------------------------------
// View: repo list (M3)
// ---------------------------------------------------------------------------

async function renderRepoList() {
  const data = await fetchJson('/api/repos');
  const repos = data.repos || [];

  if (repos.length === 0) {
    appEl.innerHTML = '<div class="empty-state">No repos registered yet.</div>';
    return;
  }

  const rows = repos
    .map((repo) => {
      const name = repo.name || repo.path;
      if (repo.stale) {
        return `
          <tr>
            <td>${escapeHtml(name)}<br><small>${escapeHtml(repo.path)}</small></td>
            <td><span class="badge badge-stale">repo not found on disk</span></td>
            <td colspan="2">-</td>
          </tr>`;
      }

      const link = `#/repos/${encodeURIComponent(repo.path)}`;
      const counts = repo.issuesByType || {};
      const badges = ISSUE_TYPES.map((type) => {
        const count = counts[type] || 0;
        const cls = count > 0 ? `badge-${type}` : 'badge-zero';
        return `<span class="badge ${cls}">${escapeHtml(type)}: ${count}</span>`;
      }).join(' ');

      return `
        <tr>
          <td><a href="${link}">${escapeHtml(name)}</a><br><small>${escapeHtml(repo.path)}</small></td>
          <td>${escapeHtml(repo.status || 'pending')}</td>
          <td>${repo.lastAnalyzedAt ? escapeHtml(repo.lastAnalyzedAt) : 'never'}</td>
          <td>${badges}</td>
        </tr>`;
    })
    .join('');

  appEl.innerHTML = `
    <h2>Registered Repositories</h2>
    <table>
      <thead>
        <tr>
          <th>Repo</th>
          <th>Status</th>
          <th>Last Analyzed</th>
          <th>Issues by Type</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// ---------------------------------------------------------------------------
// View: repo summary (M4)
// ---------------------------------------------------------------------------

async function renderRepoSummary(repoPath) {
  const data = await fetchJson(`/api/repos/${encodeURIComponent(repoPath)}/summary`);

  const breadcrumbs = `<div class="breadcrumbs"><a href="#/">&larr; All repos</a></div>`;

  const header = `
    <h2>${escapeHtml(data.path)}</h2>
    <p>Status: <strong>${escapeHtml(data.status || 'pending')}</strong> &nbsp;|&nbsp;
       Last analyzed: <strong>${data.lastAnalyzedAt ? escapeHtml(data.lastAnalyzedAt) : 'never'}</strong></p>`;

  // Type x severity matrix table
  const matrixHeader = ISSUE_SEVERITIES.map((sev) => `<th>${escapeHtml(sev)}</th>`).join('');
  const matrixRows = ISSUE_TYPES.map((type) => {
    const row = (data.issuesByTypeAndSeverity && data.issuesByTypeAndSeverity[type]) || {};
    const cells = ISSUE_SEVERITIES.map((sev) => `<td>${row[sev] ?? 0}</td>`).join('');
    return `<tr><th>${escapeHtml(type)}</th>${cells}</tr>`;
  }).join('');

  const matrix = `
    <h3>Issues by Type &times; Severity</h3>
    <table>
      <thead><tr><th></th>${matrixHeader}</tr></thead>
      <tbody>${matrixRows}</tbody>
    </table>`;

  // File list
  const files = data.files || [];
  const fileRows = files.length
    ? files
        .map((f) => {
          const link = `#/repos/${encodeURIComponent(repoPath)}/files/${f.filePath
            .split('/')
            .map((seg) => encodeURIComponent(seg))
            .join('/')}`;
          return `<tr><td><a href="${link}">${escapeHtml(f.filePath)}</a></td><td>${f.issueCount}</td></tr>`;
        })
        .join('')
    : '<tr><td colspan="2" class="empty-state">No files with issues.</td></tr>';

  const fileList = `
    <h3>Files</h3>
    <table>
      <thead><tr><th>File</th><th>Issue Count</th></tr></thead>
      <tbody>${fileRows}</tbody>
    </table>`;

  appEl.innerHTML = `
    ${breadcrumbs}
    ${header}
    <div class="charts">
      <div class="chart-container"><canvas id="type-chart"></canvas></div>
      <div class="chart-container"><canvas id="severity-chart"></canvas></div>
    </div>
    ${matrix}
    ${fileList}`;

  renderTypeChart(data.issuesByType || {});
  renderSeverityChart(data.issuesBySeverity || {});
}

function renderTypeChart(issuesByType) {
  const ctx = document.getElementById('type-chart');
  if (!ctx || typeof Chart === 'undefined') {
    return;
  }
  const chart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ISSUE_TYPES,
      datasets: [
        {
          label: 'Issues by Type',
          data: ISSUE_TYPES.map((t) => issuesByType[t] || 0),
          backgroundColor: ['#c0392b', '#8e44ad', '#d68910', '#e74c3c'],
        },
      ],
    },
    options: {
      responsive: true,
      plugins: { title: { display: true, text: 'Issues by Type' } },
    },
  });
  activeCharts.push(chart);
}

function renderSeverityChart(issuesBySeverity) {
  const ctx = document.getElementById('severity-chart');
  if (!ctx || typeof Chart === 'undefined') {
    return;
  }
  const chart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: ISSUE_SEVERITIES,
      datasets: [
        {
          label: 'Issues by Severity',
          data: ISSUE_SEVERITIES.map((s) => issuesBySeverity[s] || 0),
          backgroundColor: '#1a5fb4',
        },
      ],
    },
    options: {
      responsive: true,
      plugins: { title: { display: true, text: 'Issues by Severity' } },
      scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
    },
  });
  activeCharts.push(chart);
}

// ---------------------------------------------------------------------------
// View: file drill-down (M5)
// ---------------------------------------------------------------------------

async function renderFileDrilldown(repoPath, filePath) {
  const encodedFile = filePath
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  const data = await fetchJson(`/api/repos/${encodeURIComponent(repoPath)}/files/${encodedFile}`);

  const repoLink = `#/repos/${encodeURIComponent(repoPath)}`;
  const breadcrumbs = `
    <div class="breadcrumbs">
      <a href="#/">All repos</a> &rsaquo;
      <a href="${repoLink}">${escapeHtml(repoPath)}</a> &rsaquo;
      ${escapeHtml(data.filePath)}
    </div>`;

  const header = `
    <h2>${escapeHtml(data.filePath)}</h2>
    <p>Language: <strong>${escapeHtml(data.language)}</strong> &nbsp;|&nbsp;
       Last analyzed: <strong>${data.lastAnalyzedAt ? escapeHtml(data.lastAnalyzedAt) : 'never'}</strong></p>`;

  if (!data.analyzed) {
    appEl.innerHTML = `${breadcrumbs}${header}<div class="empty-state">Not yet analyzed.</div>`;
    return;
  }

  // Issues table
  const issues = data.issues || [];
  const issueRows = issues.length
    ? issues
        .map(
          (issue) => `
        <tr>
          <td><span class="badge badge-${escapeHtml(issue.type)}">${escapeHtml(issue.type)}</span></td>
          <td>${escapeHtml(issue.severity)}</td>
          <td>${escapeHtml(issue.ruleName || issue.ruleId)}</td>
          <td>${issue.line ?? '-'}${issue.column ? `:${issue.column}` : ''}</td>
          <td>${escapeHtml(issue.message || '')}</td>
          <td>${escapeHtml(issue.status || '')}</td>
        </tr>`,
        )
        .join('')
    : '<tr><td colspan="6" class="empty-state">No issues found.</td></tr>';

  const issuesTable = `
    <h3>Issues</h3>
    <table>
      <thead>
        <tr><th>Type</th><th>Severity</th><th>Rule</th><th>Line:Col</th><th>Message</th><th>Status</th></tr>
      </thead>
      <tbody>${issueRows}</tbody>
    </table>`;

  // Dependencies
  const dependsOn = data.dependsOn || [];
  const dependsOnRows = dependsOn.length
    ? dependsOn
        .map((dep) => {
          const target = dep.resolvedFile
            ? `<a href="#/repos/${encodeURIComponent(repoPath)}/files/${dep.resolvedFile
                .split('/')
                .map((seg) => encodeURIComponent(seg))
                .join('/')}">${escapeHtml(dep.resolvedFile)}</a>`
            : escapeHtml(dep.module);
          return `<tr><td>${escapeHtml(dep.module)}</td><td>${target}</td></tr>`;
        })
        .join('')
    : '<tr><td colspan="2" class="empty-state">No dependencies.</td></tr>';

  const dependsOnTable = `
    <h3>Depends On</h3>
    <table>
      <thead><tr><th>Module</th><th>Resolved File</th></tr></thead>
      <tbody>${dependsOnRows}</tbody>
    </table>`;

  const dependedOnBy = data.dependedOnBy || [];
  const dependedOnByRows = dependedOnBy.length
    ? dependedOnBy
        .map((file) => {
          const link = `#/repos/${encodeURIComponent(repoPath)}/files/${file
            .split('/')
            .map((seg) => encodeURIComponent(seg))
            .join('/')}`;
          return `<tr><td><a href="${link}">${escapeHtml(file)}</a></td></tr>`;
        })
        .join('')
    : '<tr><td class="empty-state">No dependents.</td></tr>';

  const dependedOnByTable = `
    <h3>Depended On By</h3>
    <table>
      <thead><tr><th>File</th></tr></thead>
      <tbody>${dependedOnByRows}</tbody>
    </table>`;

  appEl.innerHTML = `${breadcrumbs}${header}${issuesTable}${dependsOnTable}${dependedOnByTable}`;
}
