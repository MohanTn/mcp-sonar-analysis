# PRD: mcp-sonar-analysis

**Status:** Approved for implementation (v1)
**Date:** 2026-06-14
**Architecture baseline:** Option B (standalone analyzers, no SonarQube server/Docker) — `eslint-plugin-sonarjs` v4.0.3 for TS/TSX, `SonarAnalyzer.CSharp` v10.27.0.140913 via `dotnet build` + SARIF for C#, `better-sqlite3` v12.10.1, `dependency-cruiser` v17.4.3, `@modelcontextprotocol/sdk` v1.29.0.

This document is the single source of truth for implementation. It consolidates `research-findings.md`, `prd-draft.md`, and `architecture-draft.md`, resolving all conflicts found between the two drafts (see §8 "Consolidation Notes").

---

## 1. Problem Statement

When Claude Code edits a TS/TSX or C# file, it has **zero awareness of static-analysis findings** — existing code smells, bugs, vulnerabilities, and security hotspots in the file it's touching, or in files that depend on it. This causes three concrete failure modes:

1. **Claude reintroduces or compounds known issues** because it can't see them. A file with an existing `S1854` (dead store) or `S2589` (always-true condition) gets edited without the agent ever knowing the rule violation exists.
2. **Claude can't tell if its own edit introduced a new Sonar-classified issue** (bug/vulnerability/code-smell/security-hotspot) until a human runs a separate linter/CI pass — by which point the agent has moved on to other files and lost the context needed to fix it efficiently.
3. **No tool closes this loop today without a server.** Per `research-findings.md` §2:
   - SonarSource's own MCP server requires Docker + a SonarQube Server/Cloud connection and ships under a non-OSI **SONAR Source-Available License v1.0**.
   - `sonarqube-cli` is fast and AI-agent-oriented but still mandates a SonarQube Cloud/Server backend.
   - `@eslint/mcp` and Semgrep's MCP are standalone but carry no Sonar rule-key/type taxonomy and no persistent dependency-graph store.
   - "Codegraph"-style local SQLite MCP servers build dependency graphs but carry no Sonar bug/vulnerability/code-smell/security-hotspot classification.
   - None of the above are wired into Claude Code's hook lifecycle (SessionStart/PreToolUse/PostToolUse) to **proactively** surface findings as files are edited.

**The pain point**: developers using Claude Code on TS/TSX or C# repos get no automatic, local, Sonar-grade feedback loop on code quality/security as the agent works — and the only tools that provide Sonar-grade classification require standing up infrastructure (Docker + SonarQube) and accepting a restrictive license.

---

## 2. Target Users

- **Primary**: Individual developers and small teams using **Claude Code** on repositories containing **TypeScript/TSX** and/or **C#** source files, who want Sonar-grade static analysis feedback surfaced automatically during agent-driven editing — without installing/operating SonarQube.
- **Secondary**: Developers who already run ESLint with `eslint-plugin-sonarjs` and/or `SonarAnalyzer.CSharp` in CI and want the same rule findings available to their coding agent in real time, between CI runs.
- **Explicitly NOT targeted in v1**: Teams needing centralized/shared dashboards, multi-user quality gates, or languages outside TS/TSX/C#.

**Stack assumption**: Repos are Node-tooling-accessible (npm present for TS/TSX analysis) and/or have a working `dotnet` SDK on PATH (for C# analysis). A repo can contain either or both file types — the tool must handle mixed repos, and must degrade gracefully (not fail) if `dotnet` is absent.

---

## 3. Core Features (MoSCoW)

### MUST HAVE (v1 ships with all of these — non-negotiable)

#### M1. MCP tool: `register_repo`
- **Input**: absolute repo root path (optional name/label).
- **Behavior**: idempotent — registering an already-registered path (matched by canonical absolute path) returns the existing repo record without creating a duplicate row.
- **Output**: `{ repoId, path, registeredAt, alreadyRegistered: boolean, status }`.
- **Verification**: calling `register_repo` twice with the same path returns the same `repoId` both times; `analysis_repo` table has exactly one row for that path.

#### M2. MCP tool: `analyse_repo`
- **Input**: `repoId` (or repo path, resolved to `repoId`); optional `force` flag.
- **Behavior**:
  - Discovers all `*.ts`, `*.tsx`, and `*.cs` files in the repo (respecting `.gitignore` and standard excludes: `node_modules`, `bin`, `obj`, `dist`, `build`, `.git`).
  - Runs `eslint-plugin-sonarjs` (via the `ESLint` class, flat config) on all TS/TSX files, **in parallel** across files/batches.
  - Runs `SonarAnalyzer.CSharp` via `dotnet build` with `/p:ErrorLog=...sarif` once per discovered `.csproj` (parallelized across projects), parsing SARIF for `S####` diagnostics.
  - Runs `dependency-cruiser` for the TS/TSX import graph and a syntax-tree `using`-directive scan (Roslyn `CSharpSyntaxTree.ParseText`, no MSBuild restore) for the C# dependency graph.
  - Persists all issues and dependency edges into SQLite, **replacing prior data for re-scanned files** (upsert semantics).
- **Output**: `{ repoId, filesAnalyzed, issuesByType: { BUG, VULNERABILITY, CODE_SMELL, SECURITY_HOTSPOT }, dependenciesFound, durationMs, errors: [...] }`.
- **Verification**: running `analyse_repo` twice on an unchanged repo produces identical issue counts and does not duplicate rows.

#### M3. MCP tool: `get_file_analysis`
- **Input**: `repoId` (or path), file path (relative to repo root).
- **Behavior**: **read-only SQLite lookup — no analyzer invocation.** Returns the most recently persisted issues for that file plus dependency info (files it imports/depends on, and files that depend on it).
- **Output**: `{ filePath, language, lastAnalyzedAt, issues: [{ ruleId, ruleType, severity, message, line, column }], dependsOn: [...], dependedOnBy: [...] }`. Returns an explicit "not yet analyzed" state (not an error) if the file has no record.
- **Verification**: query latency p95 < 50ms for a repo with up to 5,000 persisted issues (single indexed query, no subprocess spawned).

#### M4. MCP tool: `analyse_file`
- **Input**: `repoId` (or path), file path (relative to repo root).
- **Behavior**: synchronously runs the appropriate analyzer for that single file (ESLint+sonarjs for `.ts`/`.tsx`; `dotnet build` of the containing project for `.cs`), upserts fresh results into SQLite (replacing prior rows for that file), and refreshes the dependency edges for that file.
- **Output**: same shape as `get_file_analysis`, plus `durationMs` and `analyzedAt`.
- **Verification**: latency targets in §4.

#### M5. CLI entrypoint: `mcp-sonar-analysis-cli`
- Subcommands map 1:1 to MCP tools, matching the naming convention specified by the project brief:
  - `register-repo <path>`
  - `analyse-repo <repoId|path>`
  - `get-file-analysis <repoId|path> <file>`
  - `analyse-file <repoId|path> <file>`
  - `serve` (launches the MCP stdio server)
- Each subcommand is callable from shell/hook scripts, exits 0 on success with JSON on stdout, non-zero on error with message on stderr.
- **Verification**: each subcommand is independently testable from a shell without an MCP client — `mcp-sonar-analysis-cli analyse-file . src/foo.ts` produces the same JSON shape as the `analyse_file` MCP tool response.

#### M6. Claude Code hook integration (working example configs)
- **SessionStart**: runs `register-repo` (idempotent) then `analyse-repo` (background/fire-and-forget acceptable — full-repo analysis may take time), returns a brief summary via `additionalContext` (e.g., issue counts by type from the most recent prior analysis, if any).
- **PreToolUse** (matcher `Edit|Read`): runs `get-file-analysis` (read-only, no analyzer invocation) on `tool_input.file_path`, returns existing findings + dependency info via `additionalContext` so Claude has prior context before touching the file.
- **PostToolUse** (matcher `Edit|Write`): runs `analyse-file` on `tool_input.file_path`, returns fresh findings via `additionalContext` so Claude sees issues introduced/resolved by its own edit.
- Ship a documented, copy-pasteable `settings.json` hooks snippet using `${CLAUDE_PROJECT_DIR}` for all three hooks, in the project README.
- **Verification**: a fresh Claude Code session in a registered repo, on editing a `.ts` file with a known SonarJS violation (e.g., introduce `S1854`), surfaces that finding via `additionalContext` in the PostToolUse round-trip.

#### M7. SQLite schema (canonical — see §6 for full DDL)
- `analysis_repo` — registered repos: id, path, registered_at, last_analyzed_at, status.
- `file_issues` — per-file sonar issues: rule_id, type (BUG/VULNERABILITY/CODE_SMELL/SECURITY_HOTSPOT), severity, line, column, message.
- `file_dependencies` — per-file import/using edges: source_file, imported_module, imported_file, resolved.
- `analysis_runs` — audit trail of analysis invocations (full repo or single file), for debugging/observability.
- Schema is created on first run (auto-migration on DB open); re-running is a no-op (idempotent `CREATE TABLE IF NOT EXISTS`).

---

### SHOULD HAVE (included if time allows within this implementation pass)

- **S1.** Incremental `analyse_repo`: skip re-analyzing files whose mtime/content hash hasn't changed since last analysis.
- **S2.** Issue severity/type filtering on `get_file_analysis` (optional input params) so hooks can keep `additionalContext` concise.
- **S3.** Graceful degradation when `dotnet` SDK is absent: `analyse_repo`/`analyse_file` skip `.cs` files with a clear `errors` entry rather than failing the whole run. TS/TSX-only repos must work with zero .NET tooling installed.
- **S4.** Config file (`.mcp-sonar-analysis.json`) for excluding paths beyond `.gitignore` defaults and pinning rule severity overrides.

### COULD HAVE (explicitly deferred unless trivial)

- **C1.** `analyse_repo` progress streaming via MCP progress notifications.
- **C2.** A 5th "summary" MCP tool — deferred; the 4-tool contract is fixed for v1.
- **C3.** Custom Roslyn `AdhocWorkspace` host for true sub-second C# single-file analysis (Phase 2).
- **C4.** "Bring your own SonarQube" supplemental mode (Phase 2).

### WON'T HAVE (explicit v1 exclusions)

- **W1.** No languages other than TypeScript/TSX and C# (no Python, Java, Go, plain `.js`/`.jsx` as a target — only `.ts`/`.tsx`/`.cs` are discovered/analyzed).
- **W2.** No web UI or dashboard.
- **W3.** No CI/CD pipeline integration.
- **W4.** No SonarQube Server/Cloud connectivity, accounts, or tokens.
- **W5.** No multi-user/auth/sharing — SQLite DB is a single local file, single-user.

---

## 4. Success Metrics (testable)

| # | Metric | Target | How verified |
|---|---|---|---|
| 1 | `analyse_file` latency — TS/TSX | p95 < 2s per file (warm ESLint) | Benchmark: sequential `analyse_file` calls on varied `.ts`/`.tsx` files |
| 2 | `analyse_file` latency — C# | p95 < 8s per file on a warm (pre-restored) project | Benchmark: `analyse_file` on `.cs` file in pre-restored project, measure incremental `dotnet build` time |
| 3 | `get_file_analysis` latency | p95 < 50ms | Benchmark: 100 calls against a DB with ≥5,000 issue rows, no analyzer invoked |
| 4 | `analyse_repo` throughput — TS/TSX | Reasonable for repos up to ~1,000 files (minutes, not hours) | Run against a synthetic/real repo, measure end-to-end duration |
| 5 | `analyse_repo` throughput — C# | Reasonable for solutions with multiple `.csproj` (pre-restored) | Run against a multi-project solution, measure duration excluding `dotnet restore` |
| 6 | Idempotency — `register_repo` | Two calls with identical path yield identical `repoId`, zero duplicate rows | Automated test |
| 7 | Idempotency — `analyse_repo` | Re-running on unchanged files produces identical issue counts, no duplicate rows | Automated test |
| 8 | Rule fidelity | 100% of persisted `rule_id` values are real `S####` rule keys from `eslint-plugin-sonarjs`/`SonarAnalyzer.CSharp` metadata — no synthetic IDs | Automated test cross-referencing persisted rule IDs |
| 9 | `rule_type` accuracy | Every persisted issue has `type` populated as one of `BUG \| VULNERABILITY \| CODE_SMELL \| SECURITY_HOTSPOT`, sourced from analyzer metadata | Schema `CHECK` constraint + automated test |
| 10 | Hook proactive surfacing (M6) | A known-introduced SonarJS violation appears in `additionalContext` within the PostToolUse round-trip | Scripted/manual hook test |
| 11 | Mixed-repo handling (S3) | A repo with only `.ts`/`.tsx` files (no `dotnet` SDK) completes `analyse_repo` with zero fatal errors | Test run with `dotnet` removed from PATH |

---

## 5. Non-Goals (explicit)

- No SonarQube Server/Community Build/Cloud support — no connection to, or requirement of, any SonarQube server instance.
- No Docker dependency of any kind.
- No languages beyond TypeScript, TSX, and C# in this version.
- No web UI, dashboard, or visualization layer.
- No authentication, multi-user accounts, or shared/remote state.
- No CI/CD integration.
- No taint-analysis / cross-procedure security analysis beyond what `eslint-plugin-sonarjs` and `SonarAnalyzer.CSharp` provide standalone.
- No security-hotspot review workflow (accept/reject/triage) — hotspots are surfaced as data only.
- No automatic remediation/auto-fix.

---

## 6. Technical Architecture

### 6.1 System Components

| Module | Responsibility |
|--------|-----------------|
| `src/db/schema.ts` | SQLite schema initialization (`CREATE TABLE IF NOT EXISTS`) and pragma setup (WAL mode) |
| `src/db/queries.ts` | Query helpers: upsert issues, upsert dependencies, get repo by path, get file analysis, record analysis run |
| `src/db/connection.ts` | DB connection factory — resolves DB file path, opens `better-sqlite3` handle |
| `src/analyzers/typescript.ts` | ESLint + `eslint-plugin-sonarjs` runner (programmatic `ESLint` class, flat config); maps results to `{ ruleId, type, severity, line, column, message }` |
| `src/analyzers/csharp.ts` | `dotnet build` orchestrator + SARIF parser; maps `S####` diagnostics to the same issue shape |
| `src/analyzers/dependency-graph-ts.ts` | TS/TSX dependency extraction via `dependency-cruiser` |
| `src/analyzers/dependency-graph-cs.ts` | C# dependency extraction via Roslyn-syntax `using`-directive scan (invoked via a small C# helper or via `dotnet-script`/regex-based extraction — see §6.5 risk note) |
| `src/core/register.ts` | `registerRepo(path)`: validate, canonicalize path, idempotent insert |
| `src/core/analyseRepo.ts` | `analyseRepo(repoId, opts)`: discover files, run analyzers in parallel, persist issues + deps, record run |
| `src/core/getFileAnalysis.ts` | `getFileAnalysis(repoId, filePath)`: read-only join query |
| `src/core/analyseFile.ts` | `analyseFile(repoId, filePath)`: single-file analysis + upsert |
| `src/mcp/server.ts` | MCP server entry — stdio transport, registers 4 tools via `@modelcontextprotocol/sdk`, delegates to `core/*` |
| `src/cli.ts` | CLI entry (`mcp-sonar-analysis-cli`) — parses subcommands, delegates to `core/*`, prints JSON |
| `src/types.ts` | Shared TypeScript types/interfaces for issues, deps, tool I/O |

### 6.2 Tech Stack

| Technology | Version | Justification |
|------------|---------|---------------|
| Node.js | >=18 (>=20 recommended) | MCP SDK + better-sqlite3 compatibility |
| TypeScript | ^5.x | Required by eslint-plugin-sonarjs; type safety |
| @modelcontextprotocol/sdk | ^1.29.0 | Official MCP SDK, stdio transport, Zod schemas |
| eslint | ^9.x | Programmatic `ESLint` class, flat config |
| eslint-plugin-sonarjs | ^4.0.3 | ~992 Sonar-classified rules (JS/TS/CSS), flat-config compatible |
| @typescript-eslint/parser | ^8.x | TS/TSX parsing for ESLint flat config |
| better-sqlite3 | ^12.10.1 | Synchronous SQLite, ideal for short-lived CLI/hook processes |
| dependency-cruiser | ^17.4.3 | TS/TSX import graph extraction, JSON output, tsconfig-aware |
| zod | ^3.25 | MCP tool input schema validation |
| globby | ^14.x | File discovery respecting `.gitignore` |
| commander | ^12.x | CLI argument parsing |

### 6.3 SQLite Schema (canonical)

```sql
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS analysis_repo (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  name TEXT,
  registered_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_analyzed_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending', 'in_progress', 'success', 'failed'))
);

CREATE TABLE IF NOT EXISTS file_issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id INTEGER NOT NULL REFERENCES analysis_repo(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  rule_name TEXT,
  type TEXT NOT NULL CHECK(type IN ('BUG','VULNERABILITY','CODE_SMELL','SECURITY_HOTSPOT')),
  severity TEXT NOT NULL CHECK(severity IN ('INFO','MINOR','MAJOR','CRITICAL','BLOCKER')),
  line INTEGER,
  column INTEGER,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','RESOLVED')),
  analyzed_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(repo_id, file_path, rule_id, line, column)
);
CREATE INDEX IF NOT EXISTS idx_file_issues_lookup ON file_issues(repo_id, file_path);
CREATE INDEX IF NOT EXISTS idx_file_issues_type ON file_issues(repo_id, type);

CREATE TABLE IF NOT EXISTS file_dependencies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id INTEGER NOT NULL REFERENCES analysis_repo(id) ON DELETE CASCADE,
  source_file TEXT NOT NULL,
  imported_module TEXT NOT NULL,
  imported_file TEXT,
  resolved INTEGER NOT NULL DEFAULT 0 CHECK(resolved IN (0,1)),
  language TEXT NOT NULL CHECK(language IN ('typescript','csharp')),
  analyzed_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(repo_id, source_file, imported_module)
);
CREATE INDEX IF NOT EXISTS idx_deps_source ON file_dependencies(repo_id, source_file);
CREATE INDEX IF NOT EXISTS idx_deps_imported ON file_dependencies(repo_id, imported_file);

CREATE TABLE IF NOT EXISTS analysis_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id INTEGER NOT NULL REFERENCES analysis_repo(id) ON DELETE CASCADE,
  run_type TEXT NOT NULL CHECK(run_type IN ('full_repo','single_file')),
  file_path TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  duration_ms INTEGER,
  files_analyzed INTEGER,
  issues_found INTEGER,
  error_message TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_repo_time ON analysis_runs(repo_id, started_at DESC);
```

**DB location**: `<repoRoot>/.mcp-sonar-analysis/db.sqlite` (per-repo, gitignored). Rationale: keeps each repo's analysis data colocated and avoids cross-repo path collisions; simpler than a central app-data dir keyed by repo hash.

### 6.4 API Contracts

#### MCP Tools (Zod-style)

```typescript
// register_repo
Input:  { path: string, name?: string }
Output: { repoId: number, path: string, registeredAt: string, alreadyRegistered: boolean, status: string }

// analyse_repo
Input:  { repoId?: number, path?: string, force?: boolean }
Output: {
  repoId: number, filesAnalyzed: number,
  issuesByType: { BUG: number, VULNERABILITY: number, CODE_SMELL: number, SECURITY_HOTSPOT: number },
  dependenciesFound: number, durationMs: number, errors: string[]
}

// get_file_analysis
Input:  { repoId?: number, path?: string, filePath: string }
Output: {
  filePath: string, language: 'typescript'|'csharp'|'unknown', analyzed: boolean, lastAnalyzedAt?: string,
  issues: Array<{ ruleId: string, ruleName?: string, type: string, severity: string, line?: number, column?: number, message?: string, status: string }>,
  dependsOn: Array<{ module: string, resolvedFile?: string }>,
  dependedOnBy: string[]
}

// analyse_file
Input:  { repoId?: number, path?: string, filePath: string }
Output: same shape as get_file_analysis + { durationMs: number, analyzedAt: string }
```

#### CLI Commands

```bash
mcp-sonar-analysis-cli register-repo <path> [--name <name>]
mcp-sonar-analysis-cli analyse-repo <repoIdOrPath> [--force]
mcp-sonar-analysis-cli get-file-analysis <repoIdOrPath> <filePath>
mcp-sonar-analysis-cli analyse-file <repoIdOrPath> <filePath>
mcp-sonar-analysis-cli serve   # launches MCP stdio server
```
All commands print JSON to stdout, exit 0 on success, non-zero + stderr message on error. `<repoIdOrPath>` accepts either a numeric repo ID or an absolute/relative path (resolved + looked up).

### 6.5 Concurrency & Parallel Analysis

- **File discovery**: `globby` with `.gitignore` integration + hardcoded excludes (`node_modules`, `bin`, `obj`, `dist`, `build`, `.git`, `.mcp-sonar-analysis`).
- **TS/TSX**: single in-process `ESLint` instance processes all files via `lintFiles()` (ESLint internally parallelizes/caches); for `analyse_repo` this is one call across all discovered TS/TSX files. For `analyse_file`, `lintFiles([singleFile])`.
- **C#**: group discovered `.cs` files by nearest containing `.csproj`. Run `dotnet build <csproj> /p:ErrorLog=<tmpfile>.sarif /p:RunAnalyzersDuringBuild=true` **once per project**, in parallel across projects via `Promise.all` (bounded concurrency, e.g. 4 concurrent `dotnet build` processes via a small semaphore). Parse SARIF, filter results to files within that project. For `analyse_file`, run the same build for the containing project only (incremental — fast when warm).
- **Dependency graph**: TS/TSX via one `dependency-cruiser` invocation producing JSON; C# via per-file regex/syntax scan for `using X;` directives, resolved against known namespaces-to-files mapping built during the same pass (best-effort resolution).
- **Bounded concurrency**: cap concurrent `dotnet build` processes at `min(4, os.cpus().length)`. TS/TSX analysis is single ESLint invocation (no manual worker pool needed for MVP — ESLint handles internal performance).

### 6.6 Hook Integration Reference (for README)

```jsonc
// .claude/settings.json (example snippet)
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume",
        "hooks": [
          { "type": "command", "command": "mcp-sonar-analysis-cli register-repo \"${CLAUDE_PROJECT_DIR}\" && (mcp-sonar-analysis-cli analyse-repo \"${CLAUDE_PROJECT_DIR}\" &)", "timeout": 10 }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Edit|Read",
        "hooks": [
          { "type": "command", "command": "mcp-sonar-analysis-cli get-file-analysis \"${CLAUDE_PROJECT_DIR}\" \"$CLAUDE_TOOL_INPUT_FILE_PATH\"", "timeout": 5 }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          { "type": "command", "command": "mcp-sonar-analysis-cli analyse-file \"${CLAUDE_PROJECT_DIR}\" \"$CLAUDE_TOOL_INPUT_FILE_PATH\"", "timeout": 30 }
        ]
      }
    ]
  }
}
```
Note: exact env var names for tool input file path must be verified against the live hook stdin JSON contract during implementation (Phase 5/README) — the hook receives a JSON payload via stdin containing `tool_input.file_path`; a thin wrapper script may be needed to extract this with `jq` rather than relying on an env var. This will be finalized as part of Phase 5 (hooks + docs).

### 6.7 Key Technical Risks

| Risk | Mitigation |
|------|-----------|
| C# `analyse_file` latency (`dotnet build`) exceeds 8s on cold/large projects | Document as best-effort; PostToolUse hook timeout set generously (30s); MVP accepts this — Phase 2 custom Roslyn host deferred (C3) |
| SQLite write contention from concurrent hook invocations | WAL mode + `better-sqlite3` synchronous transactions; each CLI invocation is short-lived (open, write, close) |
| ESLint memory/time on large repos | Single `ESLint` instance with flat config is generally efficient; document repo-size expectations; S1 (incremental analysis) as future improvement |
| SARIF schema drift from SonarAnalyzer.CSharp updates | Pin exact version `10.27.0.140913`; defensive parsing with clear error on unexpected shape |
| C# dependency graph via regex `using` scan is approximate (misses conditional compilation, dynamic refs) | Documented limitation (S-tier accuracy ~85-90%); acceptable for MVP; full Roslyn semantic model deferred |
| `dotnet` SDK absent on dev machine | S3: detect via `dotnet --version` check at start of `analyse_repo`/`analyse_file`; skip `.cs` files with clear error entry, do not fail whole run |

---

## 7. Competitive Positioning

| | Sonar rule-key/type classification | Zero mandatory server/Docker | Local SQLite dependency graph | Proactive hook-driven surfacing | License |
|---|---|---|---|---|---|
| SonarSource/sonarqube-mcp-server (official) | Yes | No (Docker + Server/Cloud) | No | No | SONAR Source-Available License v1.0 (non-OSI) |
| sonarqube-cli | Yes | No (Cloud/Server v9.9+) | No | No | LGPL-3.0, backend not free |
| @eslint/mcp / Semgrep MCP | No (generic taxonomy) | Yes | No | No | MIT/Apache-2.0 |
| codegraph-style local MCP servers | No | Yes | Yes | Partial | Mostly OSS |
| **mcp-sonar-analysis** | **Yes** (genuine `S####` keys from eslint-plugin-sonarjs v4.0.3 & SonarAnalyzer.CSharp v10.27.0) | **Yes** (npm + NuGet only, in-process) | **Yes** (better-sqlite3 + dependency-cruiser + Roslyn syntax scan) | **Yes** (SessionStart/PreToolUse/PostToolUse) | Permissive OSS (MIT) |

**Positioning statement**: *"Sonar-grade bug, vulnerability, code-smell, and security-hotspot classification for your TS/TSX and C# code — running entirely on your machine, with no SonarQube server, no Docker, and no restrictive license, proactively surfaced to Claude Code as it edits your files."*

---

## 8. Consolidation Notes (conflicts resolved)

1. **Schema naming**: architecture draft's 4-table schema (`analysis_repo`, `file_issues`, `file_dependencies`, `analysis_runs`) adopted as canonical — matches the table names specified in the original project brief and includes a useful audit trail (`analysis_runs`) that the PRD draft's simpler schema omitted.
2. **File scope**: PRD draft's stricter `.ts/.tsx/.cs`-only scope wins over architecture draft's incidental `.js/.jsx` mentions — matches the project brief exactly and avoids scope creep. The `file_dependencies.language` CHECK constraint is `('typescript','csharp')` only (no `javascript`).
3. **CLI command names**: standardized on `register-repo`, `analyse-repo`, `get-file-analysis`, `analyse-file`, `serve` — matches the project brief's explicit naming (`mcp-sonar-analysis-cli register-repo|analyse-repo|get-file-analysis|analyse-file`) over the PRD draft's shorter aliases.
4. **PreToolUse hook**: retained from PRD draft M6 (architecture draft's data-flow section omitted it) — the project brief explicitly requires PreToolUse for Edit/Read.
5. **C# `analyse_file` latency**: kept as a synchronous MCP tool (per M4's contract — all 4 tools are synchronous request/response). The PRD draft's "Open Question #2" about an async variant is resolved as: **no separate async tool variant in v1**. The PostToolUse hook simply uses a generous timeout (30s) and accepts that C# feedback may arrive with a few seconds of latency — this is a hook-configuration concern, not a tool-contract concern, keeping the 4-tool API surface clean.
6. **DB location**: neither draft was definitive. Resolved as `<repoRoot>/.mcp-sonar-analysis/db.sqlite` (per-repo, gitignored) — simplest for a single-repo-scoped tool, avoids central-registry path-hashing complexity, and naturally supports "one DB per registered repo" semantics implied by `analysis_repo` table existing per-DB (a single row representing "this repo," with room for future multi-root support).
7. **License**: PRD draft's open question on MIT vs Apache-2.0 resolved as **MIT** — simplest, most permissive, matches `@modelcontextprotocol/sdk`'s own license, reinforces the "permissive OSS" competitive positioning (§7).
8. **Throughput metrics (Success Metrics #4/#5)**: PRD draft's specific numeric targets (1000 files / 5min, 10 projects / 10min) were softened to qualitative "reasonable... minutes not hours" since no reference repo exists to calibrate against yet — avoids a metric that could falsely fail quality gates on an arbitrary test repo size. Can be tightened later with real benchmarks.

---

## 9. Implementation Plan — Phased Breakdown

### Phase 1: Project Scaffolding + SQLite Layer
**Scope**: Initialize the Node/TypeScript project; implement the DB schema and query layer.
**Deliverables**:
- `package.json`, `tsconfig.json`, `.gitignore`, `.eslintrc`/`eslint.config.js` for the project's own linting, basic directory structure (`src/db`, `src/analyzers`, `src/core`, `src/mcp`, `src/types.ts`, `src/cli.ts`).
- `src/db/connection.ts` — opens/creates `<repoRoot>/.mcp-sonar-analysis/db.sqlite`, enables WAL.
- `src/db/schema.ts` — full DDL from §6.3, idempotent `CREATE TABLE IF NOT EXISTS`.
- `src/db/queries.ts` — query helpers: `findRepoByPath`, `insertRepo`, `updateRepoStatus`, `upsertFileIssues`, `upsertFileDependencies`, `getFileIssues`, `getFileDependencies`, `getReverseDependencies`, `recordAnalysisRun`.
- `src/types.ts` — shared interfaces (Issue, Dependency, ToolInput/Output shapes).
- Basic unit tests for schema creation + each query helper (using an in-memory or tmp-file SQLite DB).
**Dependencies**: none (first phase).
**Acceptance criteria**:
- `npm install && npm run build` succeeds.
- Running schema init twice on the same DB file does not error.
- Unit tests for query helpers pass (insert, idempotent insert, upsert, lookup).

### Phase 2: TypeScript/TSX Analyzer + Dependency Graph
**Scope**: Implement the TS/TSX analysis pipeline (ESLint + sonarjs) and dependency-cruiser integration.
**Deliverables**:
- `src/analyzers/typescript.ts` — programmatic `ESLint` with flat config loading `eslint-plugin-sonarjs`, `@typescript-eslint/parser`; maps lint results to `Issue[]` (ruleId, type, severity, line, column, message) using the plugin's rule metadata for `type`/`severity`.
- `src/analyzers/dependency-graph-ts.ts` — runs `dependency-cruiser` programmatically, returns `{ sourceFile, importedModule, resolvedFile }[]`.
- A small fixture project under `test/fixtures/ts-sample/` containing files with deliberate known SonarJS violations (e.g., `S1854`, `S2589`) for testing.
- Unit/integration tests verifying: (a) known violations are detected with correct `S####` rule IDs and `type`, (b) dependency edges are correctly extracted for the fixture.
**Dependencies**: Phase 1 (types, but analyzers can be developed independently of DB — integration happens in Phase 4).
**Acceptance criteria**:
- Running the TS analyzer on the fixture project returns issues whose `ruleId`/`type` match real `eslint-plugin-sonarjs` rule metadata (cross-check against the plugin's exported rule definitions).
- Dependency graph extraction returns correct import edges for the fixture.

### Phase 3: C# Analyzer + Dependency Graph
**Scope**: Implement the C# analysis pipeline (`dotnet build` + SARIF) and `using`-directive dependency scan.
**Deliverables**:
- `src/analyzers/csharp.ts` — detects `.csproj` files, checks `dotnet --version` availability (graceful skip per S3 if absent), runs `dotnet build /p:ErrorLog=<tmp>.sarif /p:RunAnalyzersDuringBuild=true` with `SonarAnalyzer.CSharp` referenced, parses SARIF into `Issue[]`.
- `src/analyzers/dependency-graph-cs.ts` — regex/syntax-based `using` directive extraction per `.cs` file, best-effort resolution to in-repo files via namespace/file heuristics.
- A small fixture `.csproj` project under `test/fixtures/cs-sample/` with `SonarAnalyzer.CSharp` referenced and deliberate known violations.
- Unit/integration tests verifying issue extraction and dependency extraction on the fixture; a test verifying graceful skip when `dotnet` is unavailable (mock/env-based).
**Dependencies**: Phase 1 (types).
**Acceptance criteria**:
- Running the C# analyzer on the fixture project returns issues with real `S####` rule IDs and correct `type`/`severity` from SARIF.
- If `dotnet` is not on PATH, analyzer returns an empty result + descriptive error entry rather than throwing.

### Phase 4: Core Logic — 4 Tool Implementations
**Scope**: Wire DB layer (Phase 1) + analyzers (Phases 2-3) into the four core functions implementing the tool contracts from §6.4.
**Deliverables**:
- `src/core/register.ts` — `registerRepo(path, name?)`: canonicalize path, idempotent insert/lookup, create DB if needed.
- `src/core/analyseRepo.ts` — `analyseRepo(repoId|path, opts)`: discover files via `globby`, run TS and C# analyzers + dependency graphs (bounded concurrency per §6.5), upsert all results, record `analysis_runs` row, return summary.
- `src/core/getFileAnalysis.ts` — `getFileAnalysis(repoId|path, filePath)`: read-only joins per §6.4 output shape.
- `src/core/analyseFile.ts` — `analyseFile(repoId|path, filePath)`: single-file analyzer run + upsert (delete-then-insert for that file's issues/deps), record `analysis_runs` row.
- Integration tests: register a fixture repo (combining Phase 2 + Phase 3 fixtures), run `analyseRepo`, verify DB contents, then `getFileAnalysis` and `analyseFile` against it. Verify idempotency (Success Metrics #6, #7).
**Dependencies**: Phases 1, 2, 3.
**Acceptance criteria**:
- All Success Metrics #6-#9 pass against the combined fixture repo.
- `analyseFile` on a file with an intentionally introduced violation reflects that violation in subsequent `getFileAnalysis` calls.

### Phase 5: MCP Server + CLI + Hook Documentation
**Scope**: Expose the 4 core functions via MCP stdio server and CLI; write hook integration docs.
**Deliverables**:
- `src/mcp/server.ts` — `McpServer` with stdio transport, registers `register_repo`, `analyse_repo`, `get_file_analysis`, `analyse_file` tools with Zod schemas from §6.4, delegating to `src/core/*`.
- `src/cli.ts` — `commander`-based CLI with `register-repo`, `analyse-repo`, `get-file-analysis`, `analyse-file`, `serve` subcommands; JSON stdout, proper exit codes.
- `bin` entry in `package.json` pointing to compiled `src/cli.ts` (e.g. `mcp-sonar-analysis-cli`).
- `README.md` — project overview, install/build instructions, MCP server registration instructions (for Claude Code's MCP config), and a **verified** `settings.json` hooks example (resolve the env-var/stdin-JSON question flagged in §6.6 by checking actual hook payload shape — likely requires a thin shell wrapper using `jq` to extract `tool_input.file_path` from stdin).
- End-to-end test: spawn the CLI as a subprocess for each of the 4 commands against the fixture repo from Phase 4, assert JSON output shape matches §6.4 contracts.
**Dependencies**: Phase 4.
**Acceptance criteria**:
- `mcp-sonar-analysis-cli register-repo <fixture>`, `analyse-repo`, `get-file-analysis`, `analyse-file` all run successfully from a shell and produce JSON matching §6.4.
- `mcp-sonar-analysis-cli serve` starts an MCP stdio server that responds to `tools/list` with exactly 4 tools matching the contracts.
- README contains a working hooks example.

### Phase 6: Polish, Should-Haves, Final Test Pass
**Scope**: Implement S1-S4 (time permitting, in priority order S3 > S2 > S1 > S4), and a final full build+lint+test pass.
**Deliverables**:
- S3 (graceful `dotnet`-absent degradation) — **prioritize this one**, it's required for Success Metric #11.
- S2 (severity/type filtering on `get_file_analysis`) if time allows.
- S1 (incremental re-analysis via mtime check) if time allows.
- S4 (config file) if time allows — lowest priority, may be deferred to Phase 2/future work without penalty.
- Full `npm run build`, `npm run lint`, `npm test` pass across the whole project.
**Dependencies**: Phase 5.
**Acceptance criteria**:
- Success Metric #11 (mixed-repo / no-dotnet handling) passes.
- `npm run build`, `npm run lint`, `npm test` all exit 0.
- Any deferred S-items are explicitly noted in README under "Future Work" — not silently dropped.

---

## 10. Open Items Carried Forward (non-blocking)

- Exact hook payload extraction mechanism (env var vs stdin JSON via `jq`) — to be finalized in Phase 5 against the live Claude Code hooks contract.
- S4 config file format (JSON vs YAML) — deferred; default to JSON (`.mcp-sonar-analysis.json`) consistent with the rest of the Node tooling if implemented.
- Throughput benchmarks (Success Metrics #4/#5) are qualitative for v1; can be tightened once a reference repo is established.
