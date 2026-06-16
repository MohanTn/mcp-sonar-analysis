/**
 * Dashboard client-side application.
 *
 * Hash-based client-side routing over a single index.html:
 *   #/                                          -> repo list (M3)
 *   #/repos/<encoded-path>                      -> repo summary (M4)
 *   #/repos/<encoded-path>/files/<encoded-file> -> file drill-down (M5)
 *   #/repos/<encoded-path>/graph                -> dependency graph (M7)
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

/** Tracks the active Cytoscape instances so they can be destroyed on re-render. */
let activeCy = null;
let activeMiniCy = null;

function destroyCharts() {
  for (const chart of activeCharts) {
    chart.destroy();
  }
  activeCharts = [];
}

function destroyCy() {
  if (activeCy) {
    activeCy.destroy();
    activeCy = null;
  }
  if (activeMiniCy) {
    activeMiniCy.destroy();
    activeMiniCy = null;
  }
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

    if (segments[2] === 'graph') {
      return { view: 'graph', repoPath };
    }
  }

  return { view: 'unknown' };
}

/** Renders the view for the current route. */
async function render() {
  destroyCharts();
  destroyCy();
  const route = parseRoute();

  try {
    if (route.view === 'list') {
      await renderRepoList();
    } else if (route.view === 'summary') {
      await renderRepoSummary(route.repoPath);
    } else if (route.view === 'file') {
      await renderFileDrilldown(route.repoPath, route.filePath);
    } else if (route.view === 'graph') {
      await renderDependencyGraph(route.repoPath);
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
      const encodedPath = encodeURIComponent(repo.path);
      if (repo.stale) {
        return `
          <tr>
            <td>${escapeHtml(name)}<br><small>${escapeHtml(repo.path)}</small></td>
            <td><span class="badge badge-stale">repo not found on disk</span></td>
            <td colspan="2">-</td>
            <td><button class="btn-delete" data-path="${repo.path.replace(/"/g, '&quot;')}" title="Remove from registry">&times;</button></td>
          </tr>`;
      }

      const link = `#/repos/${encodedPath}`;
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
          <td><button class="btn-delete" data-path="${repo.path.replace(/"/g, '&quot;')}" title="Remove from registry">&times;</button></td>
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
          <th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;

  // Attach delete handlers
  document.querySelectorAll('.btn-delete').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const repoPath = btn.dataset.path;
      if (!repoPath) return;
      if (!confirm(`Remove "${repoPath}" from the registry?\n\nThe analysis data on disk is not deleted.`)) return;
      try {
        const resp = await fetch(`/api/repos/${encodeURIComponent(repoPath)}`, { method: 'DELETE' });
        if (!resp.ok) {
          const body = await resp.json().catch(() => ({}));
          alert(`Failed to remove repo: ${body.error || resp.status}`);
          return;
        }
        // Re-render the list
        render();
      } catch (err) {
        alert(`Error: ${err.message}`);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// View: repo summary (M4)
// ---------------------------------------------------------------------------

async function renderRepoSummary(repoPath) {
  const data = await fetchJson(`/api/repos/${encodeURIComponent(repoPath)}/summary`);

  const breadcrumbs = `<div class="breadcrumbs"><a href="#/">&larr; All repos</a></div>`;

  const graphLink = `#/repos/${encodeURIComponent(repoPath)}/graph`;

  const header = `
    <h2>${escapeHtml(data.path)}</h2>
    <p>Status: <strong>${escapeHtml(data.status || 'pending')}</strong> &nbsp;|&nbsp;
       Last analyzed: <strong>${data.lastAnalyzedAt ? escapeHtml(data.lastAnalyzedAt) : 'never'}</strong>
       &nbsp;|&nbsp; <a class="graph-nav-link" href="${graphLink}">&#9671; Dependency Graph</a></p>`;

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
  const graphLink = `#/repos/${encodeURIComponent(repoPath)}/graph`;
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

  // Mini dependency graph (if Cytoscape loaded and there are deps)
  const hasDeps = (dependsOn.length > 0 || dependedOnBy.length > 0) && typeof cytoscape !== 'undefined';
  const miniGraphSection = hasDeps
    ? `
    <div class="mini-graph-header">
      <h3>Dependency Graph (local)</h3>
      <a class="graph-nav-link" href="${graphLink}">Full Graph</a>
    </div>
    <div class="mini-graph-container" id="mini-graph"></div>`
    : '';

  appEl.innerHTML = `${breadcrumbs}${header}${issuesTable}${dependsOnTable}${dependedOnByTable}${miniGraphSection}`;

  // Render mini graph if applicable
  if (hasDeps) {
    renderFileMiniGraph(repoPath, data.filePath, dependsOn, dependedOnBy);
  }
}

// ---------------------------------------------------------------------------
// View: dependency graph (full repo)
// ---------------------------------------------------------------------------

async function renderDependencyGraph(repoPath) {
  const data = await fetchJson(`/api/repos/${encodeURIComponent(repoPath)}/dependencies`);

  const repoLink = `#/repos/${encodeURIComponent(repoPath)}`;
  const breadcrumbs = `
    <div class="breadcrumbs">
      <a href="#/">All repos</a> &rsaquo;
      <a href="${repoLink}">${escapeHtml(repoPath)}</a> &rsaquo;
      Dependency Graph
    </div>`;

  const nodes = data.nodes || [];
  const edges = data.edges || [];

  if (nodes.length === 0) {
    appEl.innerHTML = `${breadcrumbs}<div class="empty-state">No dependency data available for this repo. Run an analysis first.</div>`;
    return;
  }

  // Count resolved vs unresolved
  const resolvedCount = edges.filter((e) => e.resolved).length;
  const unresolvedCount = edges.filter((e) => !e.resolved).length;
  const tsNodes = nodes.filter((n) => n.language === 'typescript').length;
  const csNodes = nodes.filter((n) => n.language === 'csharp').length;

  const header = `
    <h2>Dependency Graph</h2>
    <p>${nodes.length} files, ${edges.length} edges &nbsp;|&nbsp;
       ${tsNodes} TS &middot; ${csNodes} C# &nbsp;|&nbsp;
       ${resolvedCount} resolved, ${unresolvedCount} unresolved</p>`;

  const controls = `
    <div class="graph-controls">
      <input type="search" id="graph-search" placeholder="Search files..." />
      <label><input type="checkbox" id="resolved-only" checked /> Resolved only</label>
      <button class="layout-toggle active" data-layout="cose">Cose</button>
      <button class="layout-toggle" data-layout="breadthfirst">Breadthfirst</button>
      <button class="layout-toggle" data-layout="circle">Circle</button>
    </div>
    <div class="graph-legend">
      <span class="legend-item"><span class="legend-dot" style="background:#3498db"></span> TypeScript</span>
      <span class="legend-item"><span class="legend-dot" style="background:#27ae60"></span> C#</span>
      <span class="legend-item"><span class="legend-line resolved"></span> Resolved dep</span>
      <span class="legend-item"><span class="legend-line unresolved"></span> Unresolved dep</span>
      <span class="legend-item" style="margin-left:auto;color:#777">Click a node to open file &middot; Drag to pan &middot; Scroll to zoom</span>
    </div>`;

  appEl.innerHTML = `
    ${breadcrumbs}
    ${header}
    ${controls}
    <div class="graph-container" id="cy-container">
      <div class="graph-tooltip" id="cy-tooltip" style="display:none"></div>
    </div>`;

  // Build and render the Cytoscape graph
  buildFullGraph(repoPath, nodes, edges);
}

function buildFullGraph(repoPath, nodes, edges) {
  const container = document.getElementById('cy-container');
  if (!container || typeof cytoscape === 'undefined') {
    return;
  }

  // Color by language
  const langColor = { typescript: '#3498db', csharp: '#27ae60', unknown: '#95a5a6' };

  // Size by total connections (min 18, max 50)
  const maxDegree = Math.max(1, ...nodes.map((n) => n.inDegree + n.outDegree));
  function nodeSize(n) {
    const deg = n.inDegree + n.outDegree;
    const ratio = deg / maxDegree;
    return 18 + ratio * 32;
  }

  // Build Cytoscape elements
  const cyNodes = nodes.map((n) => ({
    data: {
      id: n.id,
      label: n.baseName,
      fullPath: n.id,
      language: n.language,
      inDegree: n.inDegree,
      outDegree: n.outDegree,
    },
  }));

  // Build all edges; filter out self-loops defensively
  const cyEdges = edges
    .filter((e) => e.source !== e.target)
    .map((e, idx) => ({
    data: {
      id: `e${idx}`,
      source: e.source,
      target: e.target,
      resolved: e.resolved,
      language: e.language,
      label: e.label,
    },
  }));

  activeCy = cytoscape({
    container,
    elements: [...cyNodes, ...cyEdges],
    style: [
      {
        selector: 'node',
        style: {
          'background-color': (ele) => langColor[ele.data('language')] || langColor.unknown,
          label: 'data(label)',
          'text-valign': 'bottom',
          'text-halign': 'center',
          'font-size': '10px',
          color: '#333',
          'text-margin-y': 6,
          'text-overflow-wrap': 'anywhere',
          'text-max-width': '80px',
          width: (ele) => nodeSize(ele.data()),
          height: (ele) => nodeSize(ele.data()),
          'border-width': 2,
          'border-color': '#fff',
          'transition-property': 'width, height, border-color, background-color',
          'transition-duration': 200,
        },
      },
      {
        selector: 'edge',
        style: {
          width: 2,
          'line-color': (ele) => (ele.data('resolved') ? '#27ae60' : '#e74c3c'),
          'line-style': (ele) => (ele.data('resolved') ? 'solid' : 'dashed'),
          'target-arrow-color': (ele) => (ele.data('resolved') ? '#27ae60' : '#e74c3c'),
          'target-arrow-shape': 'triangle',
          'curve-style': 'bezier',
          opacity: 0.7,
        },
      },
      {
        selector: 'node:selected',
        style: {
          'border-color': '#e74c3c',
          'border-width': 3,
        },
      },
      {
        selector: 'node.highlight',
        style: {
          'border-color': '#f39c12',
          'border-width': 3,
        },
      },
      {
        selector: 'node.dimmed',
        style: {
          opacity: 0.25,
        },
      },
      {
        selector: 'edge.dimmed',
        style: {
          opacity: 0.1,
        },
      },
    ],
    layout: { name: 'cose', animate: false, nodeRepulsion: 8000, idealEdgeLength: 120 },
    wheelSensitivity: 0.3,
    minZoom: 0.1,
    maxZoom: 3,
  });

  // --- Interactions ---

  // Tooltip on hover
  const tooltip = document.getElementById('cy-tooltip');
  activeCy.on('mouseover', 'node', (evt) => {
    const node = evt.target;
    tooltip.style.display = 'block';
    tooltip.textContent = `${node.data('fullPath')}  (in: ${node.data('inDegree')}, out: ${node.data('outDegree')})`;
  });
  activeCy.on('mouseout', 'node', () => {
    tooltip.style.display = 'none';
  });

  // Click node -> navigate to file drill-down
  activeCy.on('tap', 'node', (evt) => {
    const node = evt.target;
    const encodedFile = node
      .data('fullPath')
      .split('/')
      .map((s) => encodeURIComponent(s))
      .join('/');
    window.location.hash = `#/repos/${encodeURIComponent(repoPath)}/files/${encodedFile}`;
  });

  // Click background -> deselect all
  activeCy.on('tap', (evt) => {
    if (evt.target === activeCy) {
      activeCy.elements().unselect().removeClass('highlight').removeClass('dimmed');
    }
  });

  // Search
  const searchInput = document.getElementById('graph-search');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      const query = searchInput.value.trim().toLowerCase();
      activeCy.nodes().removeClass('highlight').removeClass('dimmed');
      activeCy.edges().removeClass('dimmed');
      if (!query) return;
      const matches = activeCy.nodes().filter((n) => n.data('fullPath').toLowerCase().includes(query));
      if (matches.length > 0) {
        activeCy.nodes().difference(matches).addClass('dimmed');
        matches.addClass('highlight');
        // Fit to matches
        activeCy.animate({ fit: { eles: matches, padding: 60 }, duration: 300 });
      }
    });
  }

  // Resolved-only toggle
  const resolvedToggle = document.getElementById('resolved-only');
  function applyResolvedFilter() {
    if (!resolvedToggle) return;
    // Clear any search highlights when toggling filter
    activeCy.nodes().removeClass('highlight').removeClass('dimmed');
    activeCy.edges().removeClass('dimmed');
    if (searchInput) searchInput.value = '';
    if (resolvedToggle.checked) {
      activeCy.edges('[resolved = false]').style('display', 'none');
    } else {
      activeCy.edges('[resolved = false]').style('display', 'element');
    }
  }
  if (resolvedToggle) {
    resolvedToggle.addEventListener('change', applyResolvedFilter);
    // Apply initial state
    applyResolvedFilter();
  }

  // Layout toggles
  document.querySelectorAll('.layout-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.layout-toggle').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const layoutName = btn.dataset.layout;
      let layoutOpts = { name: layoutName, animate: true, animationDuration: 400 };
      if (layoutName === 'cose') {
        layoutOpts = { ...layoutOpts, nodeRepulsion: 8000, idealEdgeLength: 120 };
      } else if (layoutName === 'breadthfirst') {
        layoutOpts = { ...layoutOpts, directed: true, spacingFactor: 1.2 };
      }
      activeCy.layout(layoutOpts).run();
    });
  });
}

// ---------------------------------------------------------------------------
// Mini dependency graph for file drill-down
// ---------------------------------------------------------------------------

function renderFileMiniGraph(repoPath, filePath, dependsOn, dependedOnBy) {
  const container = document.getElementById('mini-graph');
  if (!container || typeof cytoscape === 'undefined') {
    return;
  }

  const elements = [];

  // Center node (this file)
  elements.push({
    data: {
      id: filePath,
      label: filePath.split('/').pop(),
      fullPath: filePath,
      isCenter: true,
    },
  });

  // Depends on (outgoing edges)
  for (const dep of dependsOn) {
    const targetId = dep.resolvedFile || dep.module;
    const isResolved = !!dep.resolvedFile;
    elements.push({
      data: {
        id: targetId,
        label: (dep.resolvedFile || dep.module).split('/').pop() || dep.module,
        fullPath: targetId,
        isCenter: false,
      },
    });
    elements.push({
      data: {
        id: `${filePath}->${targetId}`,
        source: filePath,
        target: targetId,
        resolved: isResolved,
        label: dep.module,
      },
    });
  }

  // Depended on by (incoming edges)
  for (const depFile of dependedOnBy) {
    const sourceId = depFile;
    // Only add node if not already present
    if (!elements.some((el) => el.data.id === sourceId)) {
      elements.push({
        data: {
          id: sourceId,
          label: sourceId.split('/').pop(),
          fullPath: sourceId,
          isCenter: false,
        },
      });
    }
    // Only add edge if not already present
    const edgeId = `${sourceId}->${filePath}`;
    if (!elements.some((el) => el.data.id === edgeId)) {
      elements.push({
        data: {
          id: edgeId,
          source: sourceId,
          target: filePath,
          resolved: true,
          label: '',
        },
      });
    }
  }

  activeMiniCy = cytoscape({
    container,
    elements,
    style: [
      {
        selector: 'node',
        style: {
          'background-color': (ele) =>
            ele.data('isCenter') ? '#e74c3c' : '#3498db',
          label: 'data(label)',
          'text-valign': 'bottom',
          'text-halign': 'center',
          'font-size': '9px',
          color: '#333',
          'text-margin-y': 4,
          'text-overflow-wrap': 'anywhere',
          'text-max-width': '70px',
          width: (ele) => (ele.data('isCenter') ? 32 : 22),
          height: (ele) => (ele.data('isCenter') ? 32 : 22),
          'border-width': (ele) => (ele.data('isCenter') ? 3 : 1),
          'border-color': (ele) => (ele.data('isCenter') ? '#c0392b' : '#fff'),
        },
      },
      {
        selector: 'edge',
        style: {
          width: 1.5,
          'line-color': (ele) => (ele.data('resolved') ? '#27ae60' : '#e74c3c'),
          'line-style': (ele) => (ele.data('resolved') ? 'solid' : 'dashed'),
          'target-arrow-color': (ele) => (ele.data('resolved') ? '#27ae60' : '#e74c3c'),
          'target-arrow-shape': 'triangle',
          'curve-style': 'bezier',
          opacity: 0.8,
        },
      },
    ],
    layout: {
      name: 'breadthfirst',
      directed: true,
      spacingFactor: 1.1,
      animate: false,
    },
    wheelSensitivity: 0.3,
    minZoom: 0.3,
    maxZoom: 2.5,
    userZoomingEnabled: true,
    userPanningEnabled: true,
  });

  // Click node -> navigate
  activeMiniCy.on('tap', 'node', (evt) => {
    const node = evt.target;
    const encodedFile = node
      .data('fullPath')
      .split('/')
      .map((s) => encodeURIComponent(s))
      .join('/');
    window.location.hash = `#/repos/${encodeURIComponent(repoPath)}/files/${encodedFile}`;
  });

  // Center on the focus node
  const centerNode = activeMiniCy.getElementById(filePath);
  if (centerNode.length > 0) {
    activeMiniCy.animate({ fit: { eles: activeMiniCy.elements(), padding: 30 }, duration: 200 });
  }
}
