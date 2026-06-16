import type Database from 'better-sqlite3';
import type {
  DependencyEdge,
  Issue,
  AnalysisRunType,
  RepoRecord,
  RepoStatus,
  IssueType,
  IssueSeverity,
} from '../types.js';

/** Row shape as returned directly by better-sqlite3 (snake_case columns). */
interface RepoRow {
  id: number;
  path: string;
  name: string | null;
  registered_at: string;
  last_analyzed_at: string | null;
  status: RepoStatus;
}

function toRepoRecord(row: RepoRow): RepoRecord {
  return {
    id: row.id,
    path: row.path,
    name: row.name,
    registeredAt: row.registered_at,
    lastAnalyzedAt: row.last_analyzed_at,
    status: row.status,
  };
}

// ---------------------------------------------------------------------------
// analysis_repo
// ---------------------------------------------------------------------------

export function findRepoByPath(db: Database.Database, path: string): RepoRecord | undefined {
  const row = db.prepare('SELECT * FROM analysis_repo WHERE path = ?').get(path) as
    | RepoRow
    | undefined;
  return row ? toRepoRecord(row) : undefined;
}

export function findRepoById(db: Database.Database, id: number): RepoRecord | undefined {
  const row = db.prepare('SELECT * FROM analysis_repo WHERE id = ?').get(id) as
    | RepoRow
    | undefined;
  return row ? toRepoRecord(row) : undefined;
}

/**
 * Idempotent insert: if a repo with this path already exists, returns it
 * unchanged (alreadyRegistered semantics are computed by the caller in
 * src/core/register.ts, which calls findRepoByPath first).
 *
 * @param explicitId - Optional globally-unique repoId to use. When provided,
 *   the row is inserted with this specific id instead of relying on
 *   AUTOINCREMENT. This ensures repoIds are globally unique across all
 *   per-repo databases.
 */
export function insertRepo(db: Database.Database, path: string, name?: string, explicitId?: number): RepoRecord {
  let result;
  if (explicitId !== undefined) {
    result = db
      .prepare('INSERT INTO analysis_repo (id, path, name) VALUES (?, ?, ?)')
      .run(explicitId, path, name ?? null);
  } else {
    result = db
      .prepare('INSERT INTO analysis_repo (path, name) VALUES (?, ?)')
      .run(path, name ?? null);
  }
  const created = findRepoById(db, explicitId ?? (result.lastInsertRowid as number));
  if (!created) {
    throw new Error(`Failed to read back inserted repo for path: ${path}`);
  }
  return created;
}

export function updateRepoStatus(
  db: Database.Database,
  repoId: number,
  status: RepoStatus,
  lastAnalyzedAt?: string,
): void {
  if (lastAnalyzedAt !== undefined) {
    db.prepare('UPDATE analysis_repo SET status = ?, last_analyzed_at = ? WHERE id = ?').run(
      status,
      lastAnalyzedAt,
      repoId,
    );
  } else {
    db.prepare('UPDATE analysis_repo SET status = ? WHERE id = ?').run(status, repoId);
  }
}

// ---------------------------------------------------------------------------
// file_issues
// ---------------------------------------------------------------------------

interface FileIssueRow {
  id: number;
  repo_id: number;
  file_path: string;
  rule_id: string;
  rule_name: string | null;
  type: IssueType;
  severity: IssueSeverity;
  line: number | null;
  column: number | null;
  message: string | null;
  status: 'OPEN' | 'RESOLVED';
  analyzed_at: string;
}

function toIssue(row: FileIssueRow): Issue {
  return {
    ruleId: row.rule_id,
    ruleName: row.rule_name ?? undefined,
    type: row.type,
    severity: row.severity,
    line: row.line ?? undefined,
    column: row.column ?? undefined,
    message: row.message ?? undefined,
    status: row.status,
  };
}

/**
 * Replace all issues for `filePath` with `issues` (upsert semantics per
 * PRD.md M2/M4: "replacing prior data for re-scanned files"). Runs inside a
 * transaction: delete existing rows for this (repo, file), then bulk-insert
 * the fresh set.
 */
export function upsertFileIssues(
  db: Database.Database,
  repoId: number,
  filePath: string,
  issues: Issue[],
): void {
  const del = db.prepare('DELETE FROM file_issues WHERE repo_id = ? AND file_path = ?');
  const insert = db.prepare(`
    INSERT INTO file_issues (repo_id, file_path, rule_id, rule_name, type, severity, line, column, message, status)
    VALUES (@repoId, @filePath, @ruleId, @ruleName, @type, @severity, @line, @column, @message, @status)
  `);

  const tx = db.transaction(() => {
    del.run(repoId, filePath);
    for (const issue of issues) {
      insert.run({
        repoId,
        filePath,
        ruleId: issue.ruleId,
        ruleName: issue.ruleName ?? null,
        type: issue.type,
        severity: issue.severity,
        line: issue.line ?? null,
        column: issue.column ?? null,
        message: issue.message ?? null,
        status: issue.status ?? 'OPEN',
      });
    }
  });
  tx();
}

export function getFileIssues(db: Database.Database, repoId: number, filePath: string): Issue[] {
  const rows = db
    .prepare('SELECT * FROM file_issues WHERE repo_id = ? AND file_path = ? ORDER BY line, column')
    .all(repoId, filePath) as FileIssueRow[];
  return rows.map(toIssue);
}

/** Returns true if `filePath` has any persisted issue rows (i.e. has been analyzed). */
export function hasFileBeenAnalyzed(
  db: Database.Database,
  repoId: number,
  filePath: string,
): boolean {
  const row = db
    .prepare('SELECT 1 FROM file_issues WHERE repo_id = ? AND file_path = ? LIMIT 1')
    .get(repoId, filePath);
  if (row) return true;
  // A file may have zero issues but still have been analyzed; check dependency
  // rows and analysis_runs as a fallback signal.
  const depRow = db
    .prepare('SELECT 1 FROM file_dependencies WHERE repo_id = ? AND source_file = ? LIMIT 1')
    .get(repoId, filePath);
  return !!depRow;
}

export function countIssuesByType(
  db: Database.Database,
  repoId: number,
): Record<IssueType, number> {
  const rows = db
    .prepare('SELECT type, COUNT(*) as cnt FROM file_issues WHERE repo_id = ? GROUP BY type')
    .all(repoId) as Array<{ type: IssueType; cnt: number }>;
  const result: Record<IssueType, number> = {
    BUG: 0,
    VULNERABILITY: 0,
    CODE_SMELL: 0,
    SECURITY_HOTSPOT: 0,
  };
  for (const row of rows) {
    result[row.type] = row.cnt;
  }
  return result;
}

// --- dashboard aggregation helpers ---

/**
 * Returns issue counts aggregated by severity for a given repo.
 * Initializes all 5 severity levels at 0, then populates from query results.
 */
export function countIssuesBySeverity(
  db: Database.Database,
  repoId: number,
): Record<IssueSeverity, number> {
  const rows = db
    .prepare('SELECT severity, COUNT(*) as cnt FROM file_issues WHERE repo_id = ? GROUP BY severity')
    .all(repoId) as Array<{ severity: IssueSeverity; cnt: number }>;
  const result: Record<IssueSeverity, number> = {
    INFO: 0,
    MINOR: 0,
    MAJOR: 0,
    CRITICAL: 0,
    BLOCKER: 0,
  };
  for (const row of rows) {
    result[row.severity] = row.cnt;
  }
  return result;
}

/**
 * Returns a 4×5 matrix of issue counts aggregated by type and severity.
 * Single query with GROUP BY type, severity. Result initialized with all
 * type×severity combinations at 0, then populated from query results.
 * Every cell is guaranteed to be a number (0 if no matching issues).
 */
export function countIssuesByTypeAndSeverity(
  db: Database.Database,
  repoId: number,
): Record<IssueType, Record<IssueSeverity, number>> {
  const rows = db
    .prepare('SELECT type, severity, COUNT(*) as cnt FROM file_issues WHERE repo_id = ? GROUP BY type, severity')
    .all(repoId) as Array<{ type: IssueType; severity: IssueSeverity; cnt: number }>;
  const result: Record<IssueType, Record<IssueSeverity, number>> = {
    BUG: { INFO: 0, MINOR: 0, MAJOR: 0, CRITICAL: 0, BLOCKER: 0 },
    VULNERABILITY: { INFO: 0, MINOR: 0, MAJOR: 0, CRITICAL: 0, BLOCKER: 0 },
    CODE_SMELL: { INFO: 0, MINOR: 0, MAJOR: 0, CRITICAL: 0, BLOCKER: 0 },
    SECURITY_HOTSPOT: { INFO: 0, MINOR: 0, MAJOR: 0, CRITICAL: 0, BLOCKER: 0 },
  };
  for (const row of rows) {
    result[row.type][row.severity] = row.cnt;
  }
  return result;
}

/**
 * Returns a list of files in the repo with their issue counts,
 * sorted by issue count descending.
 */
export function listFilesWithIssueCounts(
  db: Database.Database,
  repoId: number,
): Array<{ filePath: string; issueCount: number }> {
  const rows = db
    .prepare('SELECT file_path, COUNT(*) as cnt FROM file_issues WHERE repo_id = ? GROUP BY file_path ORDER BY cnt DESC')
    .all(repoId) as Array<{ file_path: string; cnt: number }>;
  return rows.map((row) => ({
    filePath: row.file_path,
    issueCount: row.cnt,
  }));
}

// ---------------------------------------------------------------------------
// file_dependencies
// ---------------------------------------------------------------------------

interface FileDependencyRow {
  id: number;
  repo_id: number;
  source_file: string;
  imported_module: string;
  imported_file: string | null;
  resolved: number;
  language: string;
  analyzed_at: string;
}

function toDependencyEdge(row: FileDependencyRow): DependencyEdge {
  return {
    sourceFile: row.source_file,
    importedModule: row.imported_module,
    importedFile: row.imported_file ?? undefined,
    resolved: row.resolved === 1,
    language: row.language as DependencyEdge['language'],
  };
}

/**
 * Replace all dependency edges for `sourceFile` with `edges` (upsert
 * semantics, same delete-then-insert pattern as upsertFileIssues).
 */
export function upsertFileDependencies(
  db: Database.Database,
  repoId: number,
  sourceFile: string,
  edges: DependencyEdge[],
): void {
  const del = db.prepare('DELETE FROM file_dependencies WHERE repo_id = ? AND source_file = ?');
  const insert = db.prepare(`
    INSERT INTO file_dependencies (repo_id, source_file, imported_module, imported_file, resolved, language)
    VALUES (@repoId, @sourceFile, @importedModule, @importedFile, @resolved, @language)
    ON CONFLICT(repo_id, source_file, imported_module) DO UPDATE SET
      imported_file = excluded.imported_file,
      resolved = excluded.resolved,
      language = excluded.language,
      analyzed_at = datetime('now')
  `);

  const tx = db.transaction(() => {
    del.run(repoId, sourceFile);
    for (const edge of edges) {
      insert.run({
        repoId,
        sourceFile,
        importedModule: edge.importedModule,
        importedFile: edge.importedFile ?? null,
        resolved: edge.resolved ? 1 : 0,
        language: edge.language,
      });
    }
  });
  tx();
}

export function getFileDependencies(
  db: Database.Database,
  repoId: number,
  sourceFile: string,
): DependencyEdge[] {
  const rows = db
    .prepare('SELECT * FROM file_dependencies WHERE repo_id = ? AND source_file = ?')
    .all(repoId, sourceFile) as FileDependencyRow[];
  return rows.map(toDependencyEdge);
}

/** Files that depend on (import/use) `filePath`. */
export function getReverseDependencies(
  db: Database.Database,
  repoId: number,
  filePath: string,
): string[] {
  const rows = db
    .prepare(
      'SELECT DISTINCT source_file FROM file_dependencies WHERE repo_id = ? AND imported_file = ?',
    )
    .all(repoId, filePath) as Array<{ source_file: string }>;
  return rows.map((r) => r.source_file);
}

export function countDependencies(db: Database.Database, repoId: number): number {
  const row = db
    .prepare('SELECT COUNT(*) as cnt FROM file_dependencies WHERE repo_id = ?')
    .get(repoId) as { cnt: number };
  return row.cnt;
}

/** Returns all dependency edges for a repo (for building the full dependency graph). */
export function getAllDependencies(db: Database.Database, repoId: number): DependencyEdge[] {
  const rows = db
    .prepare('SELECT * FROM file_dependencies WHERE repo_id = ?')
    .all(repoId) as FileDependencyRow[];
  return rows.map(toDependencyEdge);
}

/** Returns the set of all files that participate in any dependency edge (source or target). */
export function getAllSourceFiles(db: Database.Database, repoId: number): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT source_file AS file_path FROM file_dependencies WHERE repo_id = ?
       UNION
       SELECT DISTINCT imported_file FROM file_dependencies WHERE repo_id = ? AND imported_file IS NOT NULL`,
    )
    .all(repoId, repoId) as Array<{ file_path: string }>;
  return rows.map((r) => r.file_path);
}

// ---------------------------------------------------------------------------
// file_mtimes (S1: incremental re-analysis)
// ---------------------------------------------------------------------------

/**
 * Returns the stored mtime (ms since epoch) for `filePath`, or `undefined`
 * if the file has never been recorded.
 */
export function getFileMtime(
  db: Database.Database,
  repoId: number,
  filePath: string,
): number | undefined {
  const row = db
    .prepare('SELECT mtime_ms FROM file_mtimes WHERE repo_id = ? AND file_path = ?')
    .get(repoId, filePath) as { mtime_ms: number } | undefined;
  return row?.mtime_ms;
}

/** Upsert the stored mtime for `filePath`. */
export function setFileMtime(
  db: Database.Database,
  repoId: number,
  filePath: string,
  mtimeMs: number,
): void {
  db.prepare(`
    INSERT INTO file_mtimes (repo_id, file_path, mtime_ms)
    VALUES (?, ?, ?)
    ON CONFLICT(repo_id, file_path) DO UPDATE SET mtime_ms = excluded.mtime_ms
  `).run(repoId, filePath, mtimeMs);
}

// ---------------------------------------------------------------------------
// analysis_runs
// ---------------------------------------------------------------------------

export interface AnalysisRunInput {
  repoId: number;
  runType: AnalysisRunType;
  filePath?: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  filesAnalyzed?: number;
  issuesFound?: number;
  errorMessage?: string;
}

export function recordAnalysisRun(db: Database.Database, run: AnalysisRunInput): number {
  const result = db
    .prepare(`
      INSERT INTO analysis_runs
        (repo_id, run_type, file_path, started_at, completed_at, duration_ms, files_analyzed, issues_found, error_message)
      VALUES (@repoId, @runType, @filePath, @startedAt, @completedAt, @durationMs, @filesAnalyzed, @issuesFound, @errorMessage)
    `)
    .run({
      repoId: run.repoId,
      runType: run.runType,
      filePath: run.filePath ?? null,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      durationMs: run.durationMs,
      filesAnalyzed: run.filesAnalyzed ?? null,
      issuesFound: run.issuesFound ?? null,
      errorMessage: run.errorMessage ?? null,
    });
  return result.lastInsertRowid as number;
}
