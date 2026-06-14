# PRD: mcp-sonar-analysis

**Status:** Draft v1
**Date:** 2026-06-14
**Author:** Product Strategy (draft for review)
**Architecture baseline:** Option B (standalone analyzers, no server/Docker) per `research-findings.md` — `eslint-plugin-sonarjs` v4.0.3 for TS/TSX, `SonarAnalyzer.CSharp` v10.27.0.140913 via `dotnet build` + SARIF for C#, `better-sqlite3` v12.10.1, `dependency-cruiser` v17.4.3.

---

## 1. Problem Statement

When Claude Code edits a TS/TSX or C# file, it has **zero awareness of static-analysis findings** — existing code smells, bugs, vulnerabilities, and security hotspots in the file it's touching, or in files that depend on it. This causes three concrete failure modes:

1. **Claude reintroduces or compounds known issues** because it can't see them. A file with an existing `S1854` (dead store) or `S2589` (always-true condition) gets edited without the agent ever knowing the rule violation exists.
2. **Claude can't tell if its own edit introduced a new Sonar-classified issue** (bug/vulnerability/code-smell/security-hotspot) until a human runs a separate linter/CI pass — by which point the agent has moved on to other files and lost the context needed to fix it efficiently.
3. **No tool closes this loop today without a server.** Per `research-findings.md` §2, every existing option fails at least one of the four criteria that matter for an agentic loop:
   - SonarSource's own MCP server requires Docker + a SonarQube Server/Cloud connection and ships under a non-OSI **SONAR Source-Available License v1.0** (§1.1, §2).
   - `sonarqube-cli` ("sonar analyze --file") is fast and AI-agent-oriented but still mandates a SonarQube Cloud/Server backend (§1.1).
   - `@eslint/mcp` and Semgrep's MCP are standalone but carry no Sonar rule-key/type taxonomy and have no persistent dependency-graph store (§2).
   - The emerging "codegraph"-style local SQLite MCP servers (codebase-memory-mcp, code-graph-mcp, etc.) build dependency graphs but carry **no Sonar bug/vulnerability/code-smell/security-hotspot classification** (§2, §4).
   - None of the above are wired into Claude Code's hook lifecycle (SessionStart/PreToolUse/PostToolUse) to **proactively** surface findings as files are edited — all are pull-based, requiring the agent to remember to ask (§4).

**The pain point**: developers using Claude Code on TS/TSX or C# repos get no automatic, local, Sonar-grade feedback loop on code quality/security as the agent works — and the only tools that provide Sonar-grade classification require standing up infrastructure (Docker + SonarQube) and accepting a restrictive license.

---

## 2. Target Users

- **Primary**: Individual developers and small teams using **Claude Code** as their primary coding agent on repositories containing **TypeScript/TSX** and/or **C#** source files, who want Sonar-grade static analysis feedback surfaced automatically during agent-driven editing — without installing/operating SonarQube.
- **Secondary**: Developers who already run ESLint with `eslint-plugin-sonarjs` and/or `SonarAnalyzer.CSharp` in CI and want the same rule findings available to their coding agent in real time, between CI runs.
- **Explicitly NOT targeted in v1**: Teams needing centralized/shared dashboards across multiple developers, multi-user quality gates, or languages outside TS/TSX/C# (see Non-Goals).

**Stack assumption**: Repos are Node-tooling-accessible (npm/pnpm/yarn present for TS/TSX analysis) and/or have a working `dotnet` SDK on PATH (for C# analysis via `dotnet build`). A repo can contain either or both file types — the tool must handle mixed repos.

---

## 3. Core Features (MoSCoW)

### MUST HAVE (v1 ships with all of these — non-negotiable)

#### M1. MCP tool: `register_repo`
- **Input**: absolute repo root path (and optional repo name/label).
- **Behavior**: idempotent — registering an already-registered path returns the existing repo record (by canonical absolute path) without creating a duplicate row.
- **Output**: `{ repoId, path, registeredAt, alreadyExisted: boolean }`.
- **Verification**: calling `register_repo` twice with the same path returns the same `repoId` both times, and the `repos` table has exactly one row for that path.

#### M2. MCP tool: `analyse_repo`
- **Input**: `repoId` (or repo path, resolved to `repoId`).
- **Behavior**:
  - Discovers all `*.ts`, `*.tsx`, and `*.cs` files in the repo (respecting `.gitignore` and standard excludes: `node_modules`, `bin`, `obj`, `dist`, `build`).
  - Runs `eslint-plugin-sonarjs` (via the `ESLint` class, flat config) on all TS/TSX files, in parallel across files/batches.
  - Runs `SonarAnalyzer.CSharp` via `dotnet build` with `/p:ErrorLog=...sarif` once per discovered `.csproj`/`.sln` (parallelized across projects), parsing SARIF for `S####` diagnostics.
  - Runs `dependency-cruiser` for the TS/TSX import graph and a syntax-tree `using`-directive scan for the C# dependency graph (per research §3.2/§3.3, approach 2).
  - Persists all issues (rule key, type, severity, message, file path, line/column) and dependency edges into SQLite, replacing prior data for files that were re-scanned.
- **Output**: summary counts — `{ filesAnalyzed, issuesFound: { bugs, vulnerabilities, codeSmells, securityHotspots }, durationMs, errors: [...] }`.
- **Verification**: running `analyse_repo` twice on an unchanged repo produces identical issue counts and does not duplicate rows (upsert/replace semantics keyed on `(repoId, filePath, ruleKey, line, column)`).

#### M3. MCP tool: `get_file_analysis`
- **Input**: `repoId`, file path (relative to repo root).
- **Behavior**: read-only SQLite lookup — **no analyzer invocation**. Returns the most recently persisted issues for that file plus its dependency info (files it imports/depends on, and files that depend on it).
- **Output**: `{ filePath, lastAnalyzedAt, issues: [{ ruleKey, type, severity, message, line, column }], dependsOn: [...], dependedOnBy: [...] }`. Returns an explicit "not yet analyzed" state (not an error) if the file has no record.
- **Verification**: query latency — p95 < 50ms for a repo with up to 5,000 persisted issues (single indexed SQLite query, no analyzer subprocess spawned).

#### M4. MCP tool: `analyse_file`
- **Input**: `repoId`, file path (relative to repo root).
- **Behavior**: synchronously runs the appropriate analyzer for that single file (ESLint+sonarjs for `.ts`/`.tsx`; `dotnet build` of the containing project for `.cs`), upserts fresh results into SQLite (replacing prior rows for that file), and updates the dependency edges for that file.
- **Output**: `{ filePath, issues: [...], durationMs, analyzedAt }` — fresh findings, not cached.
- **Verification**: see Success Metrics §4 for latency targets per language.

#### M5. CLI entrypoint: `mcp-sonar-analysis-cli`
- Subcommands at minimum: `register <path>`, `analyse-repo <repoId|path>`, `get-file <repoId|path> <file>`, `analyse-file <repoId|path> <file>`.
- Each subcommand maps 1:1 to the corresponding MCP tool, callable from shell/hook scripts, exits 0 on success with JSON on stdout.
- **Verification**: each subcommand is independently testable from a shell without an MCP client — `mcp-sonar-analysis-cli analyse-file . src/foo.ts` produces the same JSON shape as the `analyse_file` MCP tool response.

#### M6. Claude Code hook integration (working example configs)
- **SessionStart**: runs `register` (idempotent) then `analyse-repo`, returns a summary (issue counts by type) via `additionalContext`.
- **PostToolUse** (matcher `Edit|Write`): runs `analyse-file` on `tool_input.file_path`, returns fresh findings via `additionalContext` so Claude sees issues introduced/resolved by its own edit.
- **PreToolUse** (matcher `Edit|Read`): runs `get-file` (read-only, no analysis) on `tool_input.file_path`, returns existing findings via `additionalContext` so Claude has prior context before touching the file.
- Ship a documented, copy-pasteable `settings.json` hooks snippet using `${CLAUDE_PROJECT_DIR}` for all three hooks.
- **Verification**: a fresh Claude Code session in a registered repo, on editing a `.ts` file with a known SonarJS violation (e.g., introduce `S1854`), surfaces that finding in the next turn's context without the user manually invoking a tool.

#### M7. SQLite schema (minimum viable)
- `repos(id, path, name, registered_at)` — unique constraint on `path`.
- `files(id, repo_id, path, last_analyzed_at, language)` — unique on `(repo_id, path)`.
- `issues(id, file_id, rule_key, rule_type, severity, message, line, column, created_at)` — `rule_type` constrained to `BUG | VULNERABILITY | CODE_SMELL | SECURITY_HOTSPOT`; indexed on `file_id`.
- `dependencies(id, repo_id, from_file_id, to_file_id)` — represents "from imports/uses to"; indexed on both `from_file_id` and `to_file_id` for bidirectional lookup (`dependsOn` / `dependedOnBy`).
- **Verification**: schema is created via migration on first `register_repo` call; re-running migrations on an existing DB is a no-op (idempotent migrations).

---

### SHOULD HAVE (strongly desirable, included if time allows within this implementation pass)

- **S1. Incremental `analyse_repo`**: skip re-analyzing files whose mtime/content hash hasn't changed since last analysis, to make repeat full-repo runs faster on large repos.
- **S2. Issue severity filtering on `get_file_analysis`**: optional input parameter to filter returned issues by `rule_type` and/or minimum severity, so hooks can keep `additionalContext` concise.
- **S3. Graceful degradation when `dotnet` SDK is absent**: `analyse_repo`/`analyse_file` should skip `.cs` files with a clear `errors` entry (e.g., `"dotnet not found on PATH"`) rather than failing the whole run — TS/TSX-only repos must work with zero `.NET` tooling installed.
- **S4. Config file** (`.mcp-sonar-analysis.json` or similar) for excluding paths beyond `.gitignore` defaults, and for pinning ESLint/SonarAnalyzer rule severity overrides.

### COULD HAVE (nice-to-have, explicitly deferred unless trivial)

- **C1. `analyse_repo` progress streaming** via MCP progress notifications for very large repos.
- **C2. Summary/dashboard tool** (a 5th MCP tool, e.g. `get_repo_summary`) returning aggregate counts by rule type/severity across the whole repo — deferred because the 4-tool contract is fixed for v1 and this can be derived client-side from `get_file_analysis` calls or a direct SQL query documented for power users.
- **C3. Custom Roslyn `AdhocWorkspace` host for true sub-second C# single-file analysis** (research §1.2 "Phase 2 stretch") — v1 accepts `dotnet build`-based latency for `analyse_file` on `.cs` files.
- **C4. "Bring your own SonarQube" supplemental mode** (research §1.3) — optional future integration that layers server-side findings (taint analysis, hotspot review workflow) on top of local results.

### WON'T HAVE (explicit v1 exclusions — see also Non-Goals)

- **W1.** No support for languages other than TypeScript/TSX and C# (no Python, Java, Go, plain JS-without-TS, etc.) in v1.
- **W2.** No web UI or dashboard of any kind.
- **W3.** No CI/CD pipeline integration (no GitHub Actions templates, no PR-decoration, no quality gates).
- **W4.** No SonarQube Server/Cloud connectivity, accounts, or tokens — fully offline-capable for analysis (network only needed for initial `npm`/`dotnet` package installation).
- **W5.** No multi-user/auth/sharing — SQLite DB is a single local file per repo, single-user.

---

## 4. Success Metrics (testable)

| # | Metric | Target | How verified |
|---|---|---|---|
| 1 | `analyse_file` latency — TS/TSX | p95 < 2 seconds per file (warm ESLint process/cache) | Benchmark script: 50 sequential `analyse_file` calls on varied `.ts`/`.tsx` files in a mid-size repo (≥200 files), measure wall-clock per call |
| 2 | `analyse_file` latency — C# | p95 < 8 seconds per file on a warm (previously-built) project | Benchmark script: `analyse_file` on a `.cs` file in a pre-restored solution, measure `dotnet build` incremental time |
| 3 | `get_file_analysis` latency | p95 < 50ms | Benchmark: 100 calls against a DB with ≥5,000 issue rows, no analyzer invoked |
| 4 | `analyse_repo` throughput — TS/TSX | ≤ 5 minutes for a repo with 1,000 `.ts`/`.tsx` files | Run against a synthetic/real repo of that size, measure end-to-end `analyse_repo` duration |
| 5 | `analyse_repo` throughput — C# | ≤ 10 minutes for a solution with 10 `.csproj` projects (cold restore excluded; assumes pre-restored) | Run against a multi-project solution, measure duration excluding `dotnet restore` |
| 6 | Idempotency — `register_repo` | Two calls with identical path yield identical `repoId`, zero duplicate `repos` rows | Automated test: call twice, assert `repoId` equality and `SELECT COUNT(*) FROM repos WHERE path = ?` = 1 |
| 7 | Idempotency — `analyse_repo` | Re-running on unchanged files produces identical issue counts and row counts (no duplicates) | Automated test: run twice, diff `issues` table row counts and content |
| 8 | Rule fidelity | 100% of persisted `rule_key` values match real SonarJS (`S####`, JS/TS rule IDs from `eslint-plugin-sonarjs` v4.0.3 metadata) or SonarAnalyzer.CSharp (`S####`) rule catalogs — no synthetic/generic rule IDs | Automated test: cross-reference a sample of persisted `rule_key`s against the analyzer's own rule metadata export |
| 9 | `rule_type` accuracy | Every persisted issue has `rule_type` populated as one of `BUG \| VULNERABILITY \| CODE_SMELL \| SECURITY_HOTSPOT`, sourced from analyzer metadata (not inferred/guessed) | Schema constraint (`CHECK`) + automated test asserting no NULL/invalid `rule_type` values after `analyse_repo` |
| 10 | Hook proactive surfacing (M6) | A known-introduced SonarJS violation appears in `additionalContext` within the same PostToolUse round-trip (i.e., before the agent's next response) | Manual/scripted Claude Code session test per M6 verification |
| 11 | Mixed-repo handling (S3) | A repo containing only `.ts`/`.tsx` files (no `dotnet` SDK present) completes `analyse_repo` with zero fatal errors | Run in a container/environment with `dotnet` removed from PATH |

---

## 5. Non-Goals (explicit)

- **No SonarQube Server/Community Build/Cloud support** — this product does not connect to, require, or proxy any SonarQube server instance. (Differentiator — see §6.)
- **No Docker dependency of any kind.**
- **No languages beyond TypeScript, TSX, and C#** in this version — no Python, Java, Go, Kotlin, Swift, plain `.js`/`.jsx` (unless naturally covered as a byproduct of the TS toolchain — not a target), etc.
- **No web UI, dashboard, or visualization layer.** All interaction is via the 4 MCP tools, the CLI, and Claude Code hooks/`additionalContext`.
- **No authentication, multi-user accounts, or shared/remote state.** The SQLite DB is a local file scoped to one developer's machine and one repo.
- **No CI/CD integration** — no GitHub Actions, GitLab CI, Azure Pipelines templates, PR comments, or quality-gate pass/fail logic in this version.
- **No taint-analysis / cross-procedure security analysis** beyond what `eslint-plugin-sonarjs` and `SonarAnalyzer.CSharp` provide standalone (these are inherently single-project/file-scoped analyzers, not SonarQube's server-side taint engine — consistent with research §1.1's note that taint analysis is a Community Build/server feature we are explicitly not depending on).
- **No security-hotspot review workflow** (accept/reject/triage UI) — hotspots are surfaced as data (rule key, type, location) but there is no workflow state machine around them, consistent with research §1.1 noting that workflow is an Enterprise SonarQube feature we don't replicate.
- **No automatic remediation/auto-fix** — the product surfaces findings; fixing is left to Claude/the developer.

---

## 6. Competitive Positioning

Per research-findings.md §2 and §4, the competitive landscape splits into two camps, and **mcp-sonar-analysis sits in the unfilled intersection**:

| | Sonar rule-key/type classification (Bug/Vuln/Code Smell/Hotspot) | Zero mandatory server/Docker | Local SQLite dependency graph | Proactive hook-driven surfacing | License |
|---|---|---|---|---|---|
| **SonarSource/sonarqube-mcp-server** (official) | Yes | **No** — Docker + SonarQube Server/Cloud required | No | No | **SONAR Source-Available License v1.0** (non-OSI) |
| **sonarqube-cli** ("sonar analyze") | Yes | **No** — requires SonarQube Cloud/Server v9.9+ | No | No (diff-based, not hook-integrated) | LGPL-3.0 (but backend not free) |
| **@eslint/mcp** / Semgrep MCP | No (generic ESLint / Semgrep taxonomy, not Sonar) | Yes | No | No | OSS (MIT/Apache-2.0) |
| **codegraph-style local MCP servers** (codebase-memory-mcp, code-graph-mcp, etc.) | No | Yes | Yes | Partial (some auto-sync, no Sonar data) | Mostly OSS |
| **mcp-sonar-analysis (this product)** | **Yes** — genuine `S####` rule keys/types from `eslint-plugin-sonarjs` v4.0.3 and `SonarAnalyzer.CSharp` v10.27.0.140913 | **Yes** — npm + NuGet packages only, in-process | **Yes** — SQLite via `better-sqlite3`, populated by `dependency-cruiser` + Roslyn syntax scan | **Yes** — SessionStart/PreToolUse/PostToolUse hooks (M6) | Permissive OSS (to be finalized — MIT/Apache-2.0 class, not Source-Available) |

**Positioning statement**: *"Sonar-grade bug, vulnerability, code-smell, and security-hotspot classification for your TS/TSX and C# code — running entirely on your machine, with no SonarQube server, no Docker, and no restrictive license, proactively surfaced to Claude Code as it edits your files."*

This directly inverts SonarSource's own trajectory: their 2025/2026 push into the agentic-AI space (official MCP server, `sonarqube-cli` v1.0.0.2628 "designed for Claude Code and GitHub Copilot," AC/DC docs — research §4) is consistently **server/cloud-anchored and non-OSI-licensed**. mcp-sonar-analysis claims the local-first, permissively-licensed, zero-infrastructure alternative that the research identifies as currently unoccupied.

---

## 7. Open Questions for Stakeholder Sign-off

1. **License choice**: confirm MIT vs Apache-2.0 for the project itself (both satisfy "permissive" positioning in §6).
2. **C# `analyse_file` latency target (8s, metric #2)**: acceptable for PostToolUse, or does this need to be made async (fire-and-forget with results delivered on the *next* turn) to avoid perceptibly blocking the agent? Research §3.5 suggests the latter for "first-run" cost — confirm whether the 8s warm-build target is sufficient or whether M6's PostToolUse hook needs an async variant for `.cs` files specifically.
3. **Minimum repo size for throughput benchmarks (metrics #4/#5)**: are 1,000 TS files / 10 C# projects representative of target users' real repos, or should these be recalibrated against an actual reference repo?
4. **S4 config file format**: JSON vs YAML vs reuse of existing `.eslintrc`/`.editorconfig` conventions — needs a decision before implementation if S4 is in scope.
