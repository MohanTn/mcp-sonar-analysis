# PRD: Local Web Dashboard for mcp-sonar-analysis

**Status:** Approved for implementation
**Date:** 2026-06-14
**Depends on:** v1 (`docs/PRD.md`) — purely additive feature. Does not change `serve`, the 4 MCP tools, or any existing SQLite table/column for already-registered repos.

This document is the single source of truth for implementing the dashboard feature. It consolidates `docs/prd-draft-dashboard.md` (product) and `docs/architecture-draft-dashboard.md` (technical) — see §9 "Consolidation Notes" for how conflicts between the two were resolved. All implementation phase agents must follow this document; if it conflicts with anything in `docs/PRD.md` for v1 surfaces, `docs/PRD.md` wins for those surfaces (this doc only governs the new dashboard).

---

## 1. Problem Statement

Today the only ways to see Sonar-grade analysis results are: (a) call MCP tools (agent-oriented JSON, no aggregation), (b) open `<repoRoot>/.mcp-sonar-analysis/db.sqlite` in a generic SQLite browser and hand-write joins per repo, or (c) read raw `analyse-repo`/`get-file-analysis` CLI JSON. None of these let a human glance at "what's the state of my code across all the repos I've registered" in seconds, with severity/type breakdowns and per-file drill-down.

**Pain point**: no human-readable, cross-repo, visual way to answer "what does Sonar-grade analysis say about my code, right now" without SQL or manual JSON parsing.

---

## 2. Target Users

Same population as v1 (Claude Code + TS/TSX/C# developers), but in a **review/oversight** capacity rather than the agent's automatic in-the-loop consumption:

| | v1 (MCP tools + hooks) | Dashboard |
|---|---|---|
| Consumer | Claude Code (agent) | The human developer |
| Mode | Automatic, per-file, machine-readable | On-demand, cross-repo, human-readable |
| Question | "What do I need to know about *this file* right now?" | "What's the state of *my code* across repos?" |

---

## 3. Core Features (MoSCoW)

### MUST HAVE

#### M1. New CLI subcommand: `dashboard`
- **Command**: `mcp-sonar-analysis-cli dashboard [--port <n>]`
- Starts a local HTTP server bound to **`127.0.0.1` only** (never `0.0.0.0`/`::`), **default port `4319`**. Prints `Dashboard running at http://127.0.0.1:<port>` to stdout, runs in foreground until `Ctrl+C` (same convention as `serve`).
- Does not start, stop, or interact with the MCP stdio server. `serve` is completely unaffected — separate command, separate process.
- If the port is already in use: fail fast with a clear error message and exit code 1 (no auto-increment, no retry loop): `Port <n> already in use. Try --port <different-port>.`
- **Verification**: `dashboard --port 5555` only opens a listener on `127.0.0.1:5555` (no other interfaces); `GET http://127.0.0.1:5555/` returns HTTP 200 with dashboard HTML. Running it again on the same port exits 1 with the message above.

#### M2. Global repo registry (`~/.mcp-sonar-analysis/registry.json`)
- **Location**: `~/.mcp-sonar-analysis/registry.json` (user home directory — mirrors the existing per-repo `.mcp-sonar-analysis/` naming convention, just at `$HOME` instead of repo root).
- **Shape**:
  ```json
  {
    "repos": [
      {
        "repoId": 1,
        "path": "/home/user/project-a",
        "name": "project-a",
        "dbPath": "/home/user/project-a/.mcp-sonar-analysis/db.sqlite",
        "registeredAt": "2026-06-14T10:30:00.000Z"
      }
    ]
  }
  ```
  - `repoId` is the `analysis_repo.id` from **that repo's own DB** (per-repo DBs each have their own autoincrement ids — `repoId` is NOT globally unique across repos in this file, but `path` is). The dashboard's per-repo routes use `path` (URL-encoded) as the canonical key, NOT a global numeric id, to avoid collisions. `repoId` is stored only as a convenience/debugging field.
- **Write path**: `src/core/register.ts`'s `registerRepo()` upserts (by `path`, matching existing dedup semantics) an entry into this file **after** its existing per-repo DB insert/lookup succeeds. This is a pure side-effect addition — failure to write the registry (e.g. unwritable `$HOME`) must NOT fail `register_repo` itself; log a warning to stderr and continue (registration to the per-repo DB is the source of truth and must remain reliable).
- **Read path**: dashboard reads this file read-only on each `/api/repos` request (no caching needed — file is tiny). If the file doesn't exist yet (no repo ever registered since upgrading, or fresh install), treat as `{ "repos": [] }` — render an empty state, not an error.
- **Backward compatibility / self-healing**: repos registered before this feature shipped have no registry entry. The registry is populated lazily — the *next* `register_repo` (or `analyse_repo`, which internally re-resolves the repo) call for that repo writes/updates its entry. No filesystem crawl for orphaned DBs (explicitly WON'T HAVE, see §5 W1).
- **Stale entries**: if `dbPath` no longer exists on disk (repo directory deleted), the dashboard's repo list marks that entry `"stale": true` and still shows it (path + stale badge, no counts) rather than silently hiding or erroring. No automatic cleanup of `registry.json`.
- **Concurrent writes**: read-modify-write the whole JSON file. Given `register_repo` is a low-frequency, human-initiated CLI/MCP call (not a hot path), a simple read-parse-modify-write with try/catch is sufficient — no file locking required. If the write races and loses an entry, the next `register_repo`/`analyse_repo` call self-heals it (idempotent upsert).
- **Verification**: register repo A then repo B (separate temp dirs) — `registry.json` contains both entries with correct `path`/`dbPath`. Delete repo B's directory, run dashboard — repo A shows normally, repo B shows `stale: true` without crashing the repo list.

#### M3. Repo list / picker view (`GET /`)
- Landing page lists every entry from the registry (M2). Each row: repo path/name, `last_analyzed_at` and `status` (from that repo's `analysis_repo` row), total issue count broken down by **type** (BUG/VULNERABILITY/CODE_SMELL/SECURITY_HOTSPOT).
- Repos with no analysis yet show a "not yet analyzed" state (zero counts), not an error.
- Stale entries (M2) show a "repo not found on disk" badge with no counts.
- Clicking a repo (non-stale) navigates to its summary view (M4).
- **Verification**: with repo A (analyzed, has issues), repo B (registered, never analyzed), and repo C (stale) all in the registry, the landing page renders all three rows without any unhandled error/500; A shows non-zero type counts, B shows all-zero, C shows the stale badge.

#### M4. Per-repo summary view (`GET /repos/:path`)
- `:path` is the URL-encoded absolute repo path (matches registry `path`, used as lookup key into both registry and that repo's own DB).
- Shows:
  - Issue counts by **type** (reuses `countIssuesByType`).
  - Issue counts by **severity** (NEW function `countIssuesBySeverity`, mirrors `countIssuesByType` exactly — see §6).
  - A type × severity matrix table (5 types... actually 4 types × 5 severities = 20 cells) — implemented as a single new query `countIssuesByTypeAndSeverity` grouping by both columns in one pass (avoid 20 separate queries).
  - `last_analyzed_at`, `status` from `analysis_repo`.
  - A file list: distinct `file_path` values from `file_issues` for this repo with per-file issue counts (NEW function `listFilesWithIssueCounts`), each linking to M5.
- **Verification**: against a fixture DB with a hand-seeded distribution (e.g. 3 BUG/MAJOR, 2 CODE_SMELL/MINOR, 1 SECURITY_HOTSPOT/CRITICAL), the type breakdown, severity breakdown, AND the type×severity matrix cells are individually correct — not just row/column totals.

#### M5. Per-file drill-down view (`GET /repos/:path/files/*filePath`)
- Renders exactly what `getFileAnalysis()` (src/core/getFileAnalysis.ts) returns for `(repoPath, filePath)`: issues (ruleId, ruleName, type, severity, line, column, message, status), `dependsOn` (module, resolvedFile), `dependedOnBy` (file list), `language`, `lastAnalyzedAt`, `analyzed` flag.
- The backing API endpoint **calls `getFileAnalysis()` directly** — no parallel/duplicated query logic.
- `filePath` arrives via URL path segment — MUST be validated with the existing `isPathInside()` (src/util/paths.ts) against the repo root before being passed to any DB query, to prevent path traversal (e.g. `../../etc/passwd`-style segments). `getFileAnalysis()` already does its own normalization (lines 44-48); the new API handler must still reject/normalize obviously-malicious segments (e.g. reject any decoded path containing `..` path components) before calling it, as defense in depth at the HTTP boundary.
- Each `dependsOn`/`dependedOnBy` entry that refers to a resolved in-repo file links to that file's own drill-down.
- "Not yet analyzed" empty state (not an error) for files with no `file_issues`/`file_dependencies` rows, matching `getFileAnalysis()`'s existing contract.
- **Verification**: for a file with known issues and at least one dependency edge in each direction, the drill-down view's issue and dependency lists exactly match `mcp-sonar-analysis-cli get-file-analysis <repo> <file>` output for the same inputs.

#### M6. Manual refresh only — no polling
- Each view has a "Refresh" control that re-fetches from the read-only API and re-renders. No background polling, no WebSocket/SSE/EventSource.
- **Rationale**: analysis runs (seconds-to-minutes) are triggered externally (hooks, CLI, MCP). A human-oversight dashboard doesn't need live push; manual refresh is simplest, has zero idle cost, and matches v1's "cheap read, explicit refresh" philosophy for `get_file_analysis`.
- **Verification**: with the dashboard open showing counts from analysis run #1, run `analyse-repo` from a separate terminal (different counts), click Refresh — displayed counts update to match run #2 (full page reload is an acceptable implementation).

#### M7. Read-only JSON API
- `GET /api/repos` → `{ repos: [{ path, name, registeredAt, lastAnalyzedAt, status, stale, issuesByType }] }`
- `GET /api/repos/:path/summary` → `{ path, status, lastAnalyzedAt, issuesByType, issuesBySeverity, issuesByTypeAndSeverity, files: [{ filePath, issueCount }] }`
- `GET /api/repos/:path/files/*filePath` → same shape as `GetFileAnalysisOutput` (src/types.ts), produced by calling `getFileAnalysis()`.
- All GET, all read-only. No endpoint mutates `file_issues`/`file_dependencies`/`analysis_repo`.
- `:path` route segments are URL-encoded absolute paths; handlers `decodeURIComponent` then `resolve()` them before any registry/DB lookup.
- **Verification**: `curl http://127.0.0.1:<port>/api/repos` returns JSON matching the M3 view's data. A route-table test asserts every `/api/*` route is GET-only.

### SHOULD HAVE

- **S1. Severity/type client-side filter controls** on M4/M5 views (filter the already-fetched JSON payload client-side — no new API params needed).
- **S2. "Open in editor" links** (`vscode://file/<absolutePath>:<line>`) from issue rows in M5.

### COULD HAVE (explicitly deferred, not silently dropped)

- **C1. Trigger `analyse-repo`/`analyse-file` from the dashboard** (`POST /api/repos/:path/analyse`, calling the existing `analyseRepo()`/`analyseFile()` core functions — same code path as CLI/MCP, no new write logic). **Deferred from this implementation pass**: full-repo analysis can take minutes, which needs an async/progress UX (job polling or SSE) disproportionate to the locked scope ("shows issues... lets user select repo... drills down"). Re-analysis remains a CLI/MCP/hook operation for now. Tracked as a fast-follow.
- **C2. Dependency graph visualization** (beyond plain lists in M5).
- **C3. Cross-repo issue search** ("show me every BLOCKER across all repos").
- **C4. Historical trend view** from `analysis_runs`.
- **C5. Dark mode, CSV export.**

### WON'T HAVE

- **W1.** No filesystem crawl to discover orphaned `.mcp-sonar-analysis/db.sqlite` directories not in the registry.
- **W2.** No issue editing/triage/suppression from the UI.
- **W3.** No live polling/WebSocket push (M6).
- **W4.** No auth, sessions, multi-user.
- **W5.** No non-loopback binding — ever.
- **W6.** No changes to `serve`, the 4 MCP tool contracts, or existing schema columns/tables.

---

## 4. Success Metrics

| # | Metric | Target |
|---|---|---|
| 1 | Time-to-first-overview | `dashboard` → rendered repo list < 2s for ≤10 registered repos |
| 2 | Cross-repo visibility | All registered repos (including pre-feature repos that received ≥1 `register_repo`/`analyse_repo` call post-upgrade) appear in `/api/repos` |
| 3 | Summary accuracy | M4 type/severity/matrix counts exactly match a hand-seeded fixture DB |
| 4 | Drill-down parity | `/api/repos/:path/files/*filePath` response matches `get-file-analysis` CLI output for same inputs |
| 5 | Localhost-only | No listener on non-loopback interface, ever |
| 6 | Zero regression | All existing v1 CLI/MCP commands produce identical output before/after |
| 7 | Backward-compatible DB | Dashboard opens a pre-feature `db.sqlite` without error |

---

## 5. Non-Goals

- No auth/sessions/multi-user/remote access (loopback-only, ever).
- No issue editing/triage from UI.
- No filesystem-wide DB discovery (W1).
- No changes to `serve`, MCP tool contracts, or existing schema tables/columns.
- No live polling/WebSocket.
- No new heavy runtime dependencies — Node built-in `http` + CDN-loaded Chart.js only (see §6).
- No mobile-responsive requirement; desktop browser only.
- No i18n.

---

## 6. Technical Architecture (Implementation Source of Truth)

### 6.1 New dependencies
**None at runtime.** Node's built-in `http` module for the server; Chart.js loaded via `<script src="https://cdn.jsdelivr.net/npm/chart.js">` from the static HTML (no npm install). No new devDependencies required.

### 6.2 New files

```
src/dashboard/
  server.ts          # HTTP server: routing, static file serving, port binding (127.0.0.1 only)
  api.ts             # Route handlers for /api/repos, /api/repos/:path/summary, /api/repos/:path/files/*filePath
  registry.ts        # Read/write ~/.mcp-sonar-analysis/registry.json
  public/
    index.html       # SPA shell: repo list, summary view, drill-down view (client-side routing via hash or simple show/hide)
    app.js           # fetch() calls to /api/*, renders DOM, Chart.js for type/severity charts
    style.css        # minimal layout/cards/tables
```

### 6.3 Registry module (`src/dashboard/registry.ts`)
- `readRegistry(): RegistryFile` — reads `~/.mcp-sonar-analysis/registry.json`, returns `{ repos: [] }` if missing/unparseable (log warning, don't throw).
- `upsertRegistryEntry(entry: RegistryEntry): void` — read-modify-write, upsert by `path`. Called from `src/core/register.ts` after successful `insertRepo`/`findRepoByPath`. Wrapped in try/catch — never throws to caller (warn to stderr on failure).
- `getDashboardHomeDir(): string` — returns `~/.mcp-sonar-analysis` (use `os.homedir()`), creating it if missing.

### 6.4 register.ts change
In `src/core/register.ts`, after the existing `insertRepo`/`findRepoByPath` logic resolves `created`/`existing`, call `upsertRegistryEntry({ repoId, path: canonicalPath, name, dbPath: getDbPath(canonicalPath), registeredAt })` (use `getDbPath` already exported from `src/db/connection.ts`). This applies on BOTH the "already registered" and "newly registered" branches (self-healing for pre-existing repos).

### 6.5 New query functions (`src/db/queries.ts`)
Add alongside existing `countIssuesByType`:
- `countIssuesBySeverity(db, repoId): Record<IssueSeverity, number>` — same pattern as `countIssuesByType` but `GROUP BY severity`, initialized with all 5 severities at 0.
- `countIssuesByTypeAndSeverity(db, repoId): Record<IssueType, Record<IssueSeverity, number>>` — single `GROUP BY type, severity` query, result matrix initialized with all type×severity combinations at 0.
- `listFilesWithIssueCounts(db, repoId): Array<{ filePath: string; issueCount: number }>` — `SELECT file_path, COUNT(*) FROM file_issues WHERE repo_id = ? GROUP BY file_path ORDER BY COUNT(*) DESC`.

All three follow existing file conventions (typed row interfaces where needed, JSDoc comment, grouped under a `// --- dashboard aggregation helpers ---` section).

### 6.6 HTTP server (`src/dashboard/server.ts`)
- `createDashboardServer(): http.Server` — builds an `http.Server` with a request handler that:
  1. Serves static files from `public/` for `/`, `/index.html`, `/app.js`, `/style.css` (read from disk relative to the module's own location via `new URL('./public/...', import.meta.url)` — works identically whether running from `src/` via `tsx` or `dist/` after build, AS LONG AS `public/` is copied alongside the compiled `server.js`).
  2. Routes `/api/*` to `src/dashboard/api.ts` handlers.
  3. Any other path → 404 JSON `{ error: 'not found' }`.
- `startDashboardServer(port: number): Promise<void>`:
  - `server.listen(port, '127.0.0.1')`. On `'error'` event with `code === 'EADDRINUSE'`, print `Port <port> already in use. Try --port <different-port>.` to stderr and `process.exit(1)`.
  - On success, `console.log('Dashboard running at http://127.0.0.1:' + port)`.

### 6.7 Build step for static assets
`tsc` does not copy non-`.ts` files. Update `package.json`'s `build` script:
```json
"build": "tsc -p tsconfig.json && cp -r src/dashboard/public dist/dashboard/public"
```
And add `"dist/dashboard/public"` is already covered by existing `"dist"` entry in `files` array (package.json `files: ["dist", ...]` already includes all of `dist/`, no change needed there — confirm during implementation).

### 6.8 API handlers (`src/dashboard/api.ts`)
- `handleListRepos(req, res)`: `readRegistry()`, for each entry check `existsSync(dbPath)` (mark `stale` if not), else `openDb(path)` read-only-ish (better-sqlite3 has no strict read-only open in current usage — open normally, since `openDb` calls `initSchema` which is idempotent `CREATE TABLE IF NOT EXISTS` and is safe), `findRepoByPath`, `countIssuesByType`, close db. Return JSON array.
- `handleRepoSummary(req, res, path)`: decode `path`, `resolve()`, look up registry entry (404 if not found), `openDb`, `findRepoByPath` (404 if no `analysis_repo` row), `countIssuesByType`, `countIssuesBySeverity`, `countIssuesByTypeAndSeverity`, `listFilesWithIssueCounts`, close db.
- `handleFileAnalysis(req, res, path, filePath)`: decode both segments, reject if decoded `filePath` contains `..` path segments (defense in depth), call `getFileAnalysis(path, filePath)` directly (it already opens/closes its own DB).

### 6.9 CLI wiring (`src/cli.ts`)
```typescript
program
  .command('dashboard')
  .description('Start the local web dashboard (http://127.0.0.1, read-only)')
  .option('--port <n>', 'HTTP port', '4319')
  .action(async (options) => {
    try {
      const port = Number(options.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        outputError(`Invalid port: ${options.port}`);
        return;
      }
      const { startDashboardServer } = await import('./dashboard/server.js');
      await startDashboardServer(port);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outputError(message);
    }
  });
```
Placed after the `serve` command, before `program.parse(...)`.

### 6.10 Key technical risks
1. **Concurrent DB access**: dashboard opens repo DBs (via existing `openDb`, WAL mode) while `analyse_repo` may be writing elsewhere. WAL allows concurrent readers/writers — acceptable, no new mitigation needed. Each dashboard request opens, queries, and closes the DB handle (short-lived, matches existing `getFileAnalysis` pattern) — no long-held connections.
2. **registry.json races**: low-frequency writes (only on `register_repo`), read-modify-write without locking is acceptable; worst case a lost update self-heals on next registration. Document this assumption, do not over-engineer file locking.
3. **Path traversal**: `/api/repos/:path/files/*filePath` — `filePath` segments must be checked for `..` before calling `getFileAnalysis`, plus rely on existing `isPathInside` inside `getFileAnalysis`. Both layers required (defense in depth at HTTP boundary + existing core logic).
4. **Port binding**: `EADDRINUSE` → exit 1 with clear message (M1). Ports <1024 require root — let Node's natural `EACCES` surface via the same error handler with the OS message; do not special-case.
5. **Stale registry entries**: handled via `existsSync(dbPath)` check at read time (M2) — no migration/cleanup needed.

---

## 7. Implementation Plan — Phases

Each phase is implemented by one Haiku "Disciplined Builder" agent, sequentially. Each phase's agent reads this PRD (`docs/PRD-dashboard.md`) plus the v1 PRD (`docs/PRD.md`) for conventions, implements ONLY its scope, and reports files changed + any deviations.

### Phase 1 — Global registry module + register.ts integration
**Scope**:
- Create `src/dashboard/registry.ts` with `readRegistry`, `upsertRegistryEntry`, `getDashboardHomeDir`, and the `RegistryEntry`/`RegistryFile` types (add these types to `src/types.ts` near `RepoRecord`, following existing type conventions).
- Modify `src/core/register.ts` to call `upsertRegistryEntry(...)` after both the "already registered" and "newly registered" branches, using `getDbPath` from `src/db/connection.ts`.
- Unit tests in `test/db.test.ts` or a new `test/registry.test.ts` (follow existing test file conventions — check `test/db.test.ts` and `test/core.test.ts` for patterns: temp dirs, cleanup, `node:test` + `node:assert`). Tests must use a temp `HOME`/registry path (do not write to the real `~/.mcp-sonar-analysis/registry.json` during tests — inject/override the home dir path, e.g. via an optional parameter or env var override in `getDashboardHomeDir`).

**Dependencies**: none (foundational).

**Deliverables**: `src/dashboard/registry.ts`, updated `src/types.ts`, updated `src/core/register.ts`, new/updated test file.

**Acceptance criteria**:
- `npm run build` and `npm run lint` pass.
- New tests pass: registering a repo writes a correct entry to the registry file (using an overridden/temp registry path); registering the same path twice upserts (no duplicate entries); registry read returns `{ repos: [] }` for a missing file without throwing.
- Existing tests (`test/core.test.ts`, `test/db.test.ts`, `test/cli.test.ts`) still pass unchanged — `registerRepo()`'s existing return shape/behavior is unchanged.

---

### Phase 2 — New aggregation query functions
**Scope**:
- Add `countIssuesBySeverity`, `countIssuesByTypeAndSeverity`, `listFilesWithIssueCounts` to `src/db/queries.ts`, following the exact conventions of `countIssuesByType` (typed returns, JSDoc, grouped under a clearly-commented section).
- Tests in `test/db.test.ts` (extend existing file, follow its fixture/setup pattern) covering all three new functions against a seeded DB with a known issue distribution (multiple types AND severities, including some cells that should be zero).

**Dependencies**: Phase 1 (not a hard code dependency, but keeps sequential build/test green incrementally).

**Deliverables**: updated `src/db/queries.ts`, updated `test/db.test.ts`.

**Acceptance criteria**:
- `npm run build`, `npm run lint`, `npm test` all pass.
- `countIssuesByTypeAndSeverity` returns a full 4×5 matrix (all `IssueType` × `IssueSeverity` combinations present, zero-filled where no issues exist) — verified against a fixture with a non-trivial distribution including at least one zero cell that must read as `0` not `undefined`.

---

### Phase 3 — Dashboard HTTP server, API handlers, CLI wiring
**Scope**:
- Create `src/dashboard/server.ts` (HTTP server, static file serving, routing, port binding/error handling per §6.6) and `src/dashboard/api.ts` (route handlers per §6.8), using ONLY Node built-ins (`http`, `node:url`, `node:fs`, `node:path`) plus existing project modules (`openDb`, `findRepoByPath`, `countIssuesByType`, `countIssuesBySeverity`, `countIssuesByTypeAndSeverity`, `listFilesWithIssueCounts`, `getFileAnalysis`, `readRegistry`, `isPathInside`).
- Add the `dashboard` subcommand to `src/cli.ts` per §6.9.
- Create minimal placeholder static files at `src/dashboard/public/{index.html,app.js,style.css}` — can be minimal/plain at this stage (e.g. index.html with a `<div id="app">Loading...</div>` and app.js that fetches `/api/repos` and `console.log`s it); Phase 4 builds out the real UI. The goal of this phase is a working, tested API + server + routing layer.
- Update `package.json` `build` script per §6.7 (copy `src/dashboard/public` → `dist/dashboard/public`).
- Tests: new `test/dashboard.test.ts` — start the server on an ephemeral port (`port: 0`, read assigned port from `server.address()`), make `fetch()`/`http.get` calls to `/api/repos`, `/api/repos/:path/summary`, `/api/repos/:path/files/*filePath`, and `/` (static HTML), assert response shapes and status codes. Include a path-traversal test (`..` in `filePath` → 400, not 500 or data leak). Include a `127.0.0.1`-only binding assertion if feasible (inspect `server.address()`).

**Dependencies**: Phase 1 (registry), Phase 2 (aggregation queries).

**Deliverables**: `src/dashboard/server.ts`, `src/dashboard/api.ts`, `src/dashboard/public/{index.html,app.js,style.css}` (minimal), updated `src/cli.ts`, updated `package.json`, new `test/dashboard.test.ts`.

**Acceptance criteria**:
- `npm run build`, `npm run lint`, `npm test` all pass.
- `node dist/cli.js dashboard --port 0` (or a fixed test port) starts a server; `GET /api/repos` returns valid JSON; `GET /api/repos/:path/summary` for a seeded repo returns correct `issuesByType`/`issuesBySeverity`/`issuesByTypeAndSeverity`/`files`; `GET /api/repos/:path/files/*filePath` matches `getFileAnalysis()` output for the same inputs; a `filePath` containing `..` returns 4xx, not file contents outside the repo.
- Starting `dashboard` twice on the same port: second invocation exits 1 with the documented error message.
- `serve` command and all 4 MCP tools remain unaffected (existing tests for them still pass).

---

### Phase 4 — Dashboard frontend (UI)
**Scope**:
- Build out `src/dashboard/public/index.html`, `app.js`, `style.css` into the full M3/M4/M5 views:
  - Repo list view (M3): table/cards of all repos from `/api/repos`, type-count badges, stale badges, links to summary view.
  - Repo summary view (M4): `/api/repos/:path/summary` rendered as: type breakdown chart (Chart.js bar or doughnut, loaded via CDN `<script src="https://cdn.jsdelivr.net/npm/chart.js">`), severity breakdown chart, type×severity matrix table, file list with issue counts linking to drill-down.
  - File drill-down view (M5): `/api/repos/:path/files/*filePath` rendered as issues table (rule, type, severity, line/col, message, status) and two dependency lists (dependsOn, dependedOnBy) with links.
  - Simple client-side routing (hash-based, e.g. `#/repos/<encoded-path>` and `#/repos/<encoded-path>/files/<encoded-filepath>`) within the single `index.html` — no server-side route changes needed beyond what Phase 3 built (Phase 3's server already serves `index.html` for `/`; for SPA hash routing, all UI routes are client-side fragments of `/`, so no new server routes needed — confirm Phase 3's static handler serves `index.html` for `/` only, which is sufficient for hash-based routing).
  - "Refresh" button per view (M6) — re-fetches and re-renders.
- No new test framework — but extend `test/dashboard.test.ts` (or add `test/dashboard-ui.test.ts`) with at least a smoke test: `GET /` returns HTML containing expected anchors (e.g. a recognizable `<div id="app">` or `<title>` string) and `GET /app.js`/`GET /style.css` return 200 with correct `Content-Type`.

**Dependencies**: Phase 3 (API + server must exist and be tested).

**Deliverables**: completed `src/dashboard/public/{index.html,app.js,style.css}`, extended dashboard tests.

**Acceptance criteria**:
- `npm run build`, `npm run lint`, `npm test` all pass.
- Manual verification (documented in phase report): starting `dashboard`, opening `http://127.0.0.1:<port>/` in a browser (or via `curl`/headless check) shows the repo list; navigating to a repo shows type/severity breakdowns and file list matching `/api/repos/:path/summary` JSON; navigating to a file shows issues/deps matching `/api/repos/:path/files/*filePath` JSON.
- Static assets correctly served with `Content-Type: text/html`, `application/javascript`, `text/css` respectively.

---

### Phase 5 — Documentation, build packaging, final polish
**Scope**:
- Update `README.md` (if it documents CLI commands — check existing structure) to document the `dashboard` command, its `--port` flag, default port, and the registry file location.
- Verify `package.json` `files` array correctly includes `dist/dashboard/public/**` for npm publish (per §6.7).
- Double-check `npm run build` produces a `dist/dashboard/public/` directory with all static assets after a clean build (`rm -rf dist && npm run build`).
- Add a brief "Dashboard" section to `docs/PRD.md` OR leave it solely in this doc — agent's call, but must not duplicate/contradict content (cross-reference only).
- Final full-repo sanity pass: confirm no `console.log`/debug leftovers in `src/dashboard/*`, confirm all new files have JSDoc headers matching existing file conventions (see e.g. `src/db/connection.ts`, `src/core/register.ts` headers).

**Dependencies**: Phases 1-4.

**Deliverables**: updated `README.md`, verified `package.json`, optional cross-reference in `docs/PRD.md`.

**Acceptance criteria**:
- `npm run build`, `npm run lint`, `npm test` all pass from a clean checkout (`rm -rf dist node_modules/.cache 2>/dev/null; npm run build`).
- `dist/dashboard/public/index.html` exists after `npm run build`.
- README documents `mcp-sonar-analysis-cli dashboard [--port <n>]`.

---

## 8. Code Review & Quality Gate (Stages 5-6, after Phase 5)

- Full diff across all 5 phases reviewed line-by-line (`docs/code-review-dashboard.md`).
- Final gate: `npm run build`, `npm run lint`, `npm test` must all pass (`docs/quality-report-dashboard.md`).

---

## 9. Consolidation Notes (conflicts resolved)

1. **Default port — PRD draft proposed 5180, architecture proposed 4319.** Resolved: **4319**. Rationale: arbitrary either way (no collision evidence for either), but architecture draft's CLI snippet and risk section were built around 4319; using it avoids inconsistency in the implementation-facing sections of this doc. Either is trivially overridable via `--port`.
2. **Registry location — PRD draft left open between `~/.mcp-sonar-analysis/registry.json` and XDG `~/.config/...`.** Resolved: **`~/.mcp-sonar-analysis/registry.json`**. Rationale: mirrors the existing per-repo `.mcp-sonar-analysis/` directory naming exactly (consistency > XDG purity for a single-file local tool); avoids introducing a second naming convention.
3. **`repoId` global uniqueness — architecture draft's registry JSON used a numeric `id` as if globally unique, but per-repo DBs each have independent autoincrement `analysis_repo.id` values (collisions guaranteed across repos).** Resolved: registry entries are keyed by `path` (canonical absolute path, already globally unique by definition); `repoId` is retained as a non-key debugging field only. All dashboard routes use URL-encoded `path`, not numeric id, as the per-repo lookup key. This is reflected in §6.2-6.8 above and must be followed by Phase 3.
4. **Trigger-analysis-from-dashboard (S1 in PRD draft) — architecture draft didn't address it at all.** Resolved: moved to **C1 (Could Have, explicitly deferred)**. Rationale: not in the user's locked requirements (which specify "shows issues... lets user select repo... drills down" — all read-only operations); adding a write/trigger path introduces async-job/progress-UX complexity disproportionate to this pass, and risks scope creep flagged by the orchestrator's "no gold-plating" mandate. Explicitly recorded here (not silently dropped) per the v1 PRD's own convention for deferred items.
5. **`countIssuesByTypeAndSeverity` — architecture draft proposed this as a new function; PRD draft only described the "matrix" as a UI concept without specifying the query layer.** Resolved: confirmed as a new `src/db/queries.ts` function (Phase 2), single `GROUP BY type, severity` query, avoiding 20 separate `countIssuesByType`-style calls — consistent with the orchestrator's "don't duplicate/proliferate aggregation logic" instruction.
6. **Static asset packaging — both drafts flagged that `tsc` doesn't copy non-`.ts` files but proposed slightly different fixes (architecture: `cp -r` in build script; PRD: "pre-built bundle... or read from src at runtime").** Resolved: **`cp -r src/dashboard/public dist/dashboard/public`** added to the `build` script (§6.7), AND the server resolves its static directory relative to its own module location (`import.meta.url`) so the same code works under `tsx src/cli.ts` (dev, reads `src/dashboard/public`) and `node dist/cli.js` (prod, reads `dist/dashboard/public` after the copy step) without branching logic.
