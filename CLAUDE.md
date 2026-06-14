# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

A local, server-free MCP server + CLI that brings Sonar-grade static analysis
(BUG, VULNERABILITY, CODE_SMELL, SECURITY_HOTSPOT) to TypeScript/TSX and C#
repos. TS/TSX is analyzed via ESLint + `eslint-plugin-sonarjs`; C# via
`dotnet build` + `SonarAnalyzer.CSharp` SARIF output. Results are cached in a
per-repo SQLite database. No SonarQube server, no Docker.

## Commands

```bash
npm run build   # tsc -p tsconfig.json && copy src/dashboard/public -> dist/dashboard/public
npm run lint    # eslint . --ext .ts
npm test        # node --import tsx --test test/**/*.test.ts
```

- Run a single test file: `node --import tsx --test test/core.test.ts`
- `test/cli.test.ts` and parts of `test/dashboard.test.ts` spawn
  `dist/cli.js` as a subprocess — **run `npm run build` before running those
  tests** or they'll exercise stale compiled output.
- Tests that touch the global registry set `MCP_SONAR_DASHBOARD_HOME` to a
  temp dir (via `registry.ts`'s `homeDirOverride`/env var) so they never
  write to the real `~/.mcp-sonar-analysis/registry.json`.
- C# analysis tests are skipped gracefully if `dotnet` isn't on `PATH` (same
  S3 degradation as production code).

## Architecture

### Entry points
- `src/cli.ts` — Commander-based CLI. Subcommands: `register-repo`,
  `analyse-repo`, `get-file-analysis`, `analyse-file`, `serve` (MCP stdio),
  `dashboard`. A repo can be referenced by numeric ID or by path —
  `parseRepoIdOrPath` treats all-digit args as `repoId`, everything else as a
  path.
- `src/mcp/server.ts` — MCP stdio server exposing 4 tools (`register_repo`,
  `analyse_repo`, `get_file_analysis`, `analyse_file`) with Zod input
  schemas. Each tool is a thin wrapper that calls the corresponding
  `src/core/*` function and JSON-stringifies the result; errors are returned
  as `{ error: message }` with `isError: true`, never thrown across the MCP
  boundary.

### Core (`src/core/`)
All four operations follow the same repo-resolution pattern: open a DB at
either `process.cwd()` (numeric repoId) or the resolved target path, look up
the `analysis_repo` row via `findRepoById`/`findRepoByPath`, then — if the
canonical path differs from where the DB was opened — close and reopen at the
canonical path.

- `register.ts` — idempotent; registering an existing path returns the
  existing record and self-heals the global registry entry.
- `analyseRepo.ts` — discovers `**/*.ts`, `**/*.tsx`, `**/*.cs` via `globby`
  (respects `.gitignore` plus hardcoded excludes:
  `node_modules, bin, obj, dist, build, .git, .mcp-sonar-analysis`).
  Implements **S1 incremental analysis**: each file's mtime is compared
  against `file_mtimes`; unchanged files skip re-running ESLint/`dotnet
  build` (their persisted issues are left as-is). `--force` bypasses this.
  Dependency-graph analysis always runs over the full file set (cheap,
  graph-wide). For C#, the incremental check is per-`.csproj` — if no `.cs`
  file under a project changed, `dotnet build` is skipped entirely for it.
- `getFileAnalysis.ts` — read-only; returns persisted issues + dependency
  edges (forward via `file_dependencies`, reverse via a `imported_file`
  lookup) for one file, with optional `type`/`severity` filtering (S2).
- `analyseFile.ts` — re-runs the analyzer for a single file, upserts fresh
  issues/deps, records mtime, then delegates to `getFileAnalysis` for the
  response shape (plus `durationMs`/`analyzedAt`). For C#, finds the nearest
  ancestor `.csproj` via `isPathInside`, builds that whole project, and picks
  out only the diagnostics matching the requested file (SARIF paths may be
  repo-relative, project-relative, or absolute — matched defensively).

### Analyzers (`src/analyzers/`)
- `typescript.ts` — runs ESLint programmatically with an in-memory flat
  config (`sonarjsPlugin.configs.recommended`, type-aware linting disabled
  for speed). Maps ESLint rule IDs to Sonar `S####` keys via rule metadata
  `docs.url`, then to `IssueType`/`IssueSeverity` via a static lookup table
  (`ruleTypeMap` in `mapToSonarType`) — unmapped rules default to
  `CODE_SMELL`.
- `csharp.ts` — `runCsharpAnalyzer`/`runCsharpAnalyzerForFile` run `dotnet
  build <csproj> /p:ErrorLog=<sarif> /p:RunAnalyzersDuringBuild=true` with
  bounded concurrency (`Semaphore`, up to 4 or `cpus().length`), then
  `parseSarif` maps SARIF `level`/`properties.tags`/`sonarType` to Sonar
  types/severities. `isDotnetAvailable()` gates everything for S3 graceful
  degradation when the dotnet SDK is missing.
- `dependency-graph-ts.ts` — wraps `dependency-cruiser`; an edge is
  "internal/resolved" only if `dep.resolved` is set and it's not an npm/core
  module.
- `dependency-graph-cs.ts` — **not** Roslyn-based; regex-scans `namespace`
  declarations across the repo to build a namespace→file map, then
  regex-scans each file's `using` directives and resolves them against that
  map (exact match, then parent-namespace prefix match). ~85-90% accurate by
  design (documented limitation).

### DB (`src/db/`)
- `connection.ts` — `openDb(repoRoot)` opens/creates
  `<repoRoot>/.mcp-sonar-analysis/db.sqlite`, enables WAL + foreign keys, and
  runs `initSchema`. **Every core operation opens, does its work, and closes
  the DB in a `finally`** — connections are intentionally short-lived, not
  pooled.
- `schema.ts` — canonical schema (all `CREATE ... IF NOT EXISTS`, idempotent):
  `analysis_repo`, `file_issues`, `file_dependencies`, `file_mtimes`,
  `analysis_runs`.
- `queries.ts` — all SQL lives here. `upsertFileIssues`/
  `upsertFileDependencies` use delete-then-insert-in-a-transaction semantics
  (full replacement of a file's rows), not row-level upserts (except
  `file_dependencies` also has an `ON CONFLICT` clause for the
  `(repo_id, source_file, imported_module)` unique key).

### Dashboard (`src/dashboard/`)
A completely separate, optional, read-only HTTP server (`dashboard` CLI
command, default port 4319, bound to `127.0.0.1` only) — independent of the
MCP `serve` process.
- `server.ts` — routes `/api/*` to `api.ts`, serves static files from
  `public/` (copied into `dist/dashboard/public` at build time).
- `registry.ts` — manages `~/.mcp-sonar-analysis/registry.json` (a flat list
  of `{ repoId, path, name, dbPath, registeredAt }`), written whenever
  `registerRepo` runs. `MCP_SONAR_DASHBOARD_HOME` env var (or an explicit
  `homeDirOverride` param) redirects this for tests.
- `api.ts` — `/api/repos` lists all registry entries with live issue counts
  (repos whose directory/DB no longer exists are marked `stale: true`, not
  hidden); `/api/repos/:path/summary` and `/api/repos/:path/files/*filePath`
  read from that repo's own `db.sqlite` via `getFileAnalysis`/`queries.ts`
  aggregation helpers.

### Path normalization
`src/util/paths.ts`'s `isPathInside(child, parent)` is used everywhere a path
needs to be tested for "is this under the repo root" — it's separator-aware
to avoid the classic `/repo/Foo` vs `/repo/FooBar` prefix bug. All persisted
`file_path`/`source_file` values are repo-relative.

### Types (`src/types.ts`)
Single source of truth for `Issue`, `DependencyEdge`, DB record shapes, and
every MCP tool/CLI I/O contract. Canonical spec lives in `docs/PRD.md` §6.3
(schema) and §6.4 (API contracts) — and `docs/PRD-dashboard.md` for the
dashboard's contracts.

## Conventions
- All public-facing errors (CLI stderr, MCP tool results) use the shape
  `{ error: "message" }`.
- This project's own ESLint config (`eslint.config.js`) lints `src/**/*.ts`
  only — don't confuse it with the `eslint-plugin-sonarjs` config that
  `src/analyzers/typescript.ts` builds in-memory to lint *target* repos.
- `docs/` contains the PRD, architecture draft, code review, and quality
  report for this project — check there for design rationale before making
  structural changes.
