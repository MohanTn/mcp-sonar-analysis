import type Database from 'better-sqlite3';

/**
 * Canonical SQLite schema (PRD.md §6.3). All statements are idempotent
 * (`CREATE TABLE/INDEX IF NOT EXISTS`) so re-running on an existing DB is a
 * no-op.
 */
const SCHEMA_SQL = `
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
`;

export function initSchema(db: Database.Database): void {
  db.exec(SCHEMA_SQL);
}
