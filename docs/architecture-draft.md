# mcp-sonar-analysis: Technical Architecture Draft

**Date:** 2026-06-14  
**Status:** MVP scope  
**License:** OSS (TBD)

---

## 1. System Components

| Module | Responsibility |
|--------|-----------------|
| **db/schema.ts** | SQLite schema initialization (CREATE TABLE) and migrations |
| **db/queries.ts** | Query helpers: `insertAnalysisResult()`, `getFileIssues()`, `getFileDependencies()`, `updateAnalysisStatus()` |
| **analyzers/typescript.ts** | ESLint + eslint-plugin-sonarjs runner; returns issues array with Sonar rule metadata (type, severity, rule_id) |
| **analyzers/csharp.ts** | `dotnet build` orchestrator + SARIF parser; returns issues array with `S####` rule IDs, severity, type |
| **analyzers/dependency-graph.ts** | TS/JS dependency extraction via dependency-cruiser; C# via Roslyn syntax-tree `using` parsing |
| **mcp-server.ts** | MCP server entry point; stdio transport, registers 4 tools, calls core logic |
| **cli.ts** | CLI entry point (`mcp-sonar-analysis-cli`); mirrors MCP tools 1:1 for hook invocation |
| **core/register.ts** | `register_repo(repo_path)`: validate path, create SQLite DB if needed, write repo metadata |
| **core/analyse.ts** | `analyse_repo(repo_path, parallel_workers)`: orchestrate TS/C# analyzers in parallel, write findings+deps to DB, return summary |
| **core/query.ts** | `get_file_analysis(repo_path, file_path)`: join issues+dependencies from DB, return structured output |
| **core/file-analyse.ts** | `analyse_file(repo_path, file_path)`: single-file analysis, minimal re-runs (C# project-scoped), incremental DB updates |
| **hooks/post-tool-use.ts** | PostToolUse handler: invoke `analyse_file` on Edit/Write, return findings as `additionalContext` |
| **hooks/session-start.ts** | SessionStart handler: check repo registration, call `analyse_repo` if stale, return summary as `additionalContext` |

---

## 2. Tech Stack Table

| Technology | Version | Justification |
|------------|---------|---------------|
| **Node.js** | ≥18 | MCP SDK minimum; ≥20 recommended for stability |
| **TypeScript** | 5.x | Type safety; ESLint plugin ecosystem requires TS ≥5 |
| **@modelcontextprotocol/sdk** | 1.29.0 | Official MCP SDK; stdio transport, Zod schemas |
| **eslint-plugin-sonarjs** | 4.0.3 | 992+ Sonar-classified rules (JS/TS/CSS); flat-config; ESLint ≥8 peer dep |
| **eslint** | ^8 or ^9 or ^10 | Programmatic ESLint class runner (not CLI); handles single-file linting |
| **SonarAnalyzer.CSharp** | 10.27.0.140913 | Roslyn-based; ships as NuGet analyzer package; SARIF output via `/p:ErrorLog=` |
| **better-sqlite3** | 12.10.1 | Synchronous SQLite; ideal for short-lived hook scripts; broadest Node version support |
| **dependency-cruiser** | 17.4.3 | TS/JS import graph extraction; JSON output; respects tsconfig paths |
| **@types/better-sqlite3** | 7.6.x | TypeScript bindings for better-sqlite3 |
| **@types/node** | 20.x or 22.x | Standard Node types |
| **zod** | ^3.25 or ^4 (SDK compat layer) | Runtime schema validation for MCP tool inputs |
| **dotenv** | 16.x | Load `.env` for credentials/tool paths |
| **sarif** | 2.1 | SARIF parser for C# analyzer output; standard format |

---

## 3. SQLite Schema

**Database file:** `~/.claude/mcp-sonar-analysis.db` (or configurable path)

### Table: `analysis_repos`
```sql
CREATE TABLE analysis_repos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_path TEXT UNIQUE NOT NULL,
  registered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_analyzed_at DATETIME,
  analysis_status TEXT CHECK(analysis_status IN ('pending', 'in_progress', 'success', 'failed')),
  error_message TEXT
);
CREATE INDEX idx_repos_path ON analysis_repos(repo_path);
```

### Table: `file_issues`
Denormalized per-file issue records (fast lookups for `get_file_analysis`).

```sql
CREATE TABLE file_issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id INTEGER NOT NULL,
  file_path TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  rule_title TEXT,
  type TEXT CHECK(type IN ('BUG', 'VULNERABILITY', 'CODE_SMELL', 'SECURITY_HOTSPOT')),
  severity TEXT CHECK(severity IN ('INFO', 'MINOR', 'MAJOR', 'CRITICAL')),
  line INTEGER,
  column INTEGER,
  message TEXT,
  analyzed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  analyzer TEXT CHECK(analyzer IN ('eslint-sonarjs', 'sonaranalyzer-csharp')),
  FOREIGN KEY(repo_id) REFERENCES analysis_repos(id) ON DELETE CASCADE,
  UNIQUE(repo_id, file_path, rule_id, line)
);
CREATE INDEX idx_issues_file ON file_issues(repo_id, file_path);
CREATE INDEX idx_issues_type ON file_issues(repo_id, type);
CREATE INDEX idx_issues_severity ON file_issues(repo_id, severity);
```

### Table: `file_dependencies`
Per-file import/using statements. Resolved means the dependency could be located in the repo.

```sql
CREATE TABLE file_dependencies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id INTEGER NOT NULL,
  source_file TEXT NOT NULL,
  imported_module TEXT NOT NULL,
  imported_file TEXT,
  resolved BOOLEAN DEFAULT 0,
  language TEXT CHECK(language IN ('typescript', 'javascript', 'csharp')),
  analyzed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(repo_id) REFERENCES analysis_repos(id) ON DELETE CASCADE,
  UNIQUE(repo_id, source_file, imported_module)
);
CREATE INDEX idx_deps_source ON file_dependencies(repo_id, source_file);
CREATE INDEX idx_deps_imported ON file_dependencies(repo_id, imported_file);
CREATE INDEX idx_deps_resolved ON file_dependencies(repo_id, resolved);
```

### Table: `analysis_runs`
Metadata for each full/file analysis invocation (audit trail).

```sql
CREATE TABLE analysis_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id INTEGER NOT NULL,
  run_type TEXT CHECK(run_type IN ('full_repo', 'single_file')),
  file_path TEXT,
  started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  duration_ms INTEGER,
  files_analyzed INTEGER,
  issues_found INTEGER,
  error_message TEXT,
  FOREIGN KEY(repo_id) REFERENCES analysis_repos(id) ON DELETE CASCADE
);
CREATE INDEX idx_runs_repo_time ON analysis_runs(repo_id, started_at DESC);
```

---

## 4. Data Flow

### Tool: `register_repo(repo_path: string)`
1. Validate path exists and is a directory
2. Check SQLite: `SELECT * FROM analysis_repos WHERE repo_path = ?`
3. If missing: `INSERT INTO analysis_repos(repo_path, analysis_status) VALUES (?, 'pending')`
4. Return `{ success: true, repo_id, status: 'registered' }`

### Tool: `analyse_repo(repo_path: string, parallel_workers: number = 4)`
1. Lookup repo in DB; fail if not registered
2. Set `analysis_status = 'in_progress'`
3. Discover files: glob `**/*.{ts,tsx,js,jsx,csharp}` (respect `.gitignore`)
4. **Parallel analysis**: partition files across `parallel_workers` workers
   - TS/JS files → ESLint worker pool
   - C# files → `dotnet build` once per project (extract project from `.csproj` directory), parse SARIF output
5. For each issue found:
   - `INSERT OR REPLACE INTO file_issues(repo_id, file_path, rule_id, type, severity, line, message, analyzer)`
6. Extract dependency graph (once per language):
   - TS/JS: run `dependency-cruiser --output-type json`; parse output
   - C#: walk `.cs` files, parse `using` directives via Roslyn syntax trees
   - `INSERT INTO file_dependencies(repo_id, source_file, imported_module, imported_file, resolved, language)`
7. Update `analysis_repos: analysis_status = 'success', last_analyzed_at = NOW()`
8. Return `{ success: true, files_analyzed, issues_count, dependencies_count, duration_ms }`

### Tool: `get_file_analysis(repo_path: string, file_path: string)`
1. Lookup repo ID
2. Query issues: `SELECT * FROM file_issues WHERE repo_id = ? AND file_path = ? ORDER BY line`
3. Query dependencies (this file imports):  
   `SELECT imported_module, imported_file, resolved FROM file_dependencies WHERE repo_id = ? AND source_file = ?`
4. Query reverse dependencies (files that import this file):  
   `SELECT source_file FROM file_dependencies WHERE repo_id = ? AND imported_file = ?`
5. Return structured object:
   ```json
   {
     "file_path": "src/foo.ts",
     "issues": [
       { "rule_id": "S2589", "type": "CODE_SMELL", "severity": "MAJOR", "line": 42, "message": "..." }
     ],
     "imports": [ { "module": "./bar", "resolved_to": "src/bar.ts" } ],
     "imported_by": [ "src/baz.ts" ]
   }
   ```

### Tool: `analyse_file(repo_path: string, file_path: string)`
1. Validate file exists
2. Determine language (extension)
3. **TS/JS**: run ESLint on single file in-process; get issues
4. **C#**: run `dotnet build --no-restore -consoleloggerparameters:NoSummary /p:ErrorLog=/tmp/sarif-${uuid}.sarif` on the containing project; parse SARIF for issues in target file only
5. Delete old records: `DELETE FROM file_issues WHERE repo_id = ? AND file_path = ?`
6. Insert new: `INSERT INTO file_issues(...)`
7. Re-extract file's dependencies (lightweight)
8. Return same schema as `get_file_analysis` (issues + imports + reverse deps)

### Hook: `SessionStart` (matcher: any)
1. Check if repo is registered via config (env var or `.claude/mcp-sonar-analysis.json`)
2. Query `analysis_repos` for current repo; if missing or `last_analyzed_at < (now - 24h)`, trigger `analyse_repo`
3. Query for high-severity issues (CRITICAL/MAJOR): `SELECT COUNT(*) FROM file_issues WHERE repo_id = ? AND severity IN ('CRITICAL', 'MAJOR')`
4. Return via `hookSpecificOutput.additionalContext`: a markdown summary, e.g., "2 CRITICAL bugs, 5 MAJOR vulnerabilities found in last 24h"

### Hook: `PostToolUse` (matcher: `Edit|Write`)
1. Extract `tool_input.file_path` from the just-edited file
2. If `.ts|.tsx|.js|.jsx|.cs` extension, invoke `analyse_file(repo_path, file_path)` asynchronously (non-blocking)
3. On completion, write results to DB
4. Return via `hookSpecificOutput.additionalContext`: "New issues in this file: S1234 (MAJOR) at line 10: ..."
5. If no new issues, return empty context (no noise)

---

## 5. API Contracts

### MCP Tool Schemas (Zod / JSON Schema sketch)

#### `register_repo`
**Input:**
```typescript
{
  repo_path: string  // absolute path or ~ expansion
}
```
**Output:**
```typescript
{
  success: boolean
  repo_id: number
  status: "registered" | "already_registered"
  message?: string
}
```

#### `analyse_repo`
**Input:**
```typescript
{
  repo_path: string
  parallel_workers?: number  // default 4; tuned to CPU cores
  force?: boolean  // re-analyze even if recent
}
```
**Output:**
```typescript
{
  success: boolean
  repo_id: number
  files_analyzed: number
  issues_found: number
  issues_by_type: { BUG: number; VULNERABILITY: number; CODE_SMELL: number; SECURITY_HOTSPOT: number }
  issues_by_severity: { CRITICAL: number; MAJOR: number; MINOR: number; INFO: number }
  dependencies_found: number
  duration_ms: number
  error?: string
}
```

#### `get_file_analysis`
**Input:**
```typescript
{
  repo_path: string
  file_path: string
}
```
**Output:**
```typescript
{
  file_path: string
  language: string  // "typescript" | "javascript" | "csharp"
  issues: Array<{
    rule_id: string  // e.g., "S2589"
    rule_title: string
    type: "BUG" | "VULNERABILITY" | "CODE_SMELL" | "SECURITY_HOTSPOT"
    severity: "INFO" | "MINOR" | "MAJOR" | "CRITICAL"
    line: number
    column?: number
    message: string
    analyzer: string
  }>
  imports: Array<{
    module: string  // e.g., "./utils" or "lodash"
    resolved_to?: string  // file path if in-repo
    language: string
  }>
  imported_by: Array<string>  // file paths that reference this file
}
```

#### `analyse_file`
**Input:**
```typescript
{
  repo_path: string
  file_path: string
}
```
**Output:** Same as `get_file_analysis`

---

### CLI Commands

All MCP tools are mirrored as CLI commands for hook invocation. JSON I/O via stdin/stdout.

```bash
# Register a repository
mcp-sonar-analysis-cli register-repo --repo-path /home/user/myapp

# Analyze entire repo
mcp-sonar-analysis-cli analyse-repo --repo-path /home/user/myapp --parallel-workers 4

# Get analysis for a file
mcp-sonar-analysis-cli get-file-analysis --repo-path /home/user/myapp --file-path src/main.ts

# Analyze single file (for PostToolUse hook)
mcp-sonar-analysis-cli analyse-file --repo-path /home/user/myapp --file-path src/main.ts

# MCP server (stdio)
mcp-sonar-analysis-cli serve
```

All commands exit with code 0 on success, non-zero on error; output is JSON to stdout, errors to stderr.

---

## 6. Concurrency & Parallel Analysis

**Worker Pool Pattern** (for `analyse_repo`):

1. **File partitioning**: Build two worklists:
   - `ts_files = [all .ts .tsx .js .jsx files]`
   - `cs_files = [all .cs files]`

2. **TS/JS analysis** (worker pool via `node:worker_threads` or `piscina`):
   - Pool size: `min(parallel_workers, num_cpu_cores)` (default 4)
   - Each worker runs ESLint in-process on a batch of files (e.g., 10 files per worker)
   - ESLint reuses the TS parser across files → minimal per-file startup cost
   - ESLint's built-in caching (`.eslintcache`) reduces re-linting overhead

3. **C# analysis** (serial per project, batched):
   - Discover unique `.csproj` files containing `.cs` files
   - For each project:
     - Run `dotnet build --no-restore /p:ErrorLog=/tmp/sarif-${uuid}.sarif` once
     - Parse SARIF; filter to only issues in target files (ignore external packages)
   - SARIF parse output goes into file_issues
   - Parallelism: run independent projects in parallel (e.g., if repo has 3 projects, 3 parallel `dotnet build` invocations)

4. **Dependency graph extraction** (post-issue analysis):
   - TS/JS: single `dependency-cruiser` run (fast, JSON output)
   - C#: walk all `.cs` files once, extract `using` directives in parallel

**Resource limits**:
- Worker pool size capped at 8 (prevent resource exhaustion on large machines)
- TS file batch size: 10-20 files per worker (tuned empirically)
- C# `dotnet build` per project can use `--disable-build-servers` if memory is tight; fallback to serial project analysis if parallel builds OOM

**Caching**:
- ESLint `.eslintcache` in `.eslintcache` dir (GitIgnored)
- Dependency-cruiser cache: `.dependency-cruiser-cache` (optional)
- SQLite DB itself is the persistent cache; re-analyze only files modified since last run (stat-based check, Phase 2)

---

## 7. Key Technical Risks

| Risk | Severity | Mitigation |
|------|----------|-----------|
| **C# single-file latency under 2s unachievable** — `dotnet build` on first run or large projects is 10-30s; acceptable only if async (PostToolUse non-blocking) and Claude is informed findings will come in next turn via `additionalContext`. | HIGH | Document C# analysis as "best-effort incremental" in UX; accept that first-edit on a project takes longer; offer Phase 2 option of custom Roslyn `AdhocWorkspace` host for true sub-second C# checks (requires more infra, worth it only if users demand it). Detect and warn if build fails (missing SDK, broken .csproj). |
| **SQLite concurrent write contention** — if multiple Claude Code hook handlers (SessionStart, PostToolUse, other agents) try to write simultaneously, lock contention causes slowness/timeout. | MEDIUM | Use SQLite's IMMEDIATE transactions (`BEGIN IMMEDIATE; ... COMMIT`) for all writes; set reasonable timeout (5s); implement exponential backoff + retry in CLI/MCP handler layer. Consider WAL mode (`PRAGMA journal_mode=WAL`) if contention persists; document limitation that hook handlers on the same repo are serialized by SQLite locking. |
| **ESLint memory usage on very large codebases** — `eslint` npm package can consume >1GB on repos with 100k+ JS/TS files; worker pool may not help if single ESLint instance is memory-hungry. | MEDIUM | Set `max_old_space_size` on Node process; reduce pool size or increase file batching if memory swells; offer option to skip full-repo analysis and run only on changed files (use `git diff` to filter, Phase 2). Monitor memory in integration tests. |
| **SARIF parser robustness** — if `SonarAnalyzer.CSharp` changes SARIF schema or MSBuild swallows analyzer output, parsing breaks. | MEDIUM | Pin `SonarAnalyzer.CSharp` version strictly; log full SARIF dump on parse errors (aid debugging); add SARIF schema validation (hand-rolled or via `sarif` npm package if it exists); unit tests with real project SARIF samples. |
| **Dependency graph incompleteness** — Roslyn syntax-tree `using` parsing misses dynamic imports, preprocessor conditionals, and `#if` branches; TS/JS dynamic `require()` calls likewise invisible to dependency-cruiser. | LOW | Document as "static analysis layer — does not capture runtime-only deps"; offer Phase 2 runtime-instrumentation option if users need dynamic deps. For MVP, accept 85% accuracy (covers 90%+ of real codebases' imports). |

---

## 8. Configuration & Deployment

### `.claude/mcp-sonar-analysis.json` (in user's home or project)
```json
{
  "repository_path": "/absolute/path/to/repo",
  "sqlite_db_path": "~/.claude/mcp-sonar-analysis.db",
  "parallel_workers": 4,
  "ts_enabled": true,
  "csharp_enabled": true,
  "exclude_patterns": ["node_modules", "dist", "build", ".git"],
  "auto_analyze_on_session_start": true,
  "auto_analyze_threshold_hours": 24
}
```

### `settings.json` hooks (Claude Code integration)
```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume",
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PROJECT_DIR}/hooks/session-start.sh",
            "timeout": 10
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "if": "*.ts|*.tsx|*.js|*.jsx|*.cs",
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PROJECT_DIR}/hooks/post-tool-use.sh",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

Hook scripts invoke the CLI commands (e.g., `mcp-sonar-analysis-cli analyse-file`) asynchronously, parse JSON, format output.

---

## 9. MVP Scope & Phase 2 Roadmap

### MVP Deliverables
- 4 MCP tools + CLI mirror (register_repo, analyse_repo, get_file_analysis, analyse_file)
- SQLite schema + basic queries
- TS/JS analysis via ESLint + eslint-plugin-sonarjs (v4.0.3)
- C# analysis via dotnet build + SARIF parsing (SonarAnalyzer.CSharp v10.27.0.140913)
- Dependency graph (TS/JS via dependency-cruiser, C# via syntax-tree `using`)
- SessionStart + PostToolUse hook handlers
- Basic testing (unit: analyzers, DB queries; integration: full repo analysis end-to-end)

### Phase 2 Candidates
- Custom Roslyn `AdhocWorkspace` host for sub-second C# single-file checks
- Incremental analysis (track file mtimes, skip unchanged files)
- Git-aware analysis (analyze only changed files in PR/branch)
- Cross-file impact analysis (given a change, list affected files)
- Rule filtering/tuning UI (allow Claude to silence noisy rules per repo)
- Taint-analysis mode (opt-in SonarQube Cloud integration for advanced vulnerability detection)
- IDE plugin (VSCode extension mirroring MCP tool results locally)

---

## 10. Deliverables Checklist

- [x] System components table (10 core modules)
- [x] Tech stack (versions + justification)
- [x] SQLite schema (4 tables, indexes for fast lookups)
- [x] Data flow (4 tools + 2 hooks)
- [x] API contracts (Zod-style schemas, CLI signatures)
- [x] Concurrency approach (worker pool, per-language strategy, caching)
- [x] Top 5 technical risks + mitigations
- [x] Configuration snippets
- [x] MVP scope + Phase 2 roadmap

Total lines: ~450 (dense, no fluff).
