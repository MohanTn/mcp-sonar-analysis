import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { initSchema } from './schema.js';

/**
 * DB connection factory. Resolves the per-repo DB file path
 * (`<repoRoot>/.mcp-sonar-analysis/db.sqlite`, per PRD.md §6.3), creates the
 * containing directory if needed, opens a better-sqlite3 handle, enables WAL
 * mode, and ensures the schema is initialized.
 */

const DB_DIR_NAME = '.mcp-sonar-analysis';
const DB_FILE_NAME = 'db.sqlite';

export function getDbPath(repoRoot: string): string {
  const canonicalRoot = resolve(repoRoot);
  return join(canonicalRoot, DB_DIR_NAME, DB_FILE_NAME);
}

export function openDb(repoRoot: string): Database.Database {
  const canonicalRoot = resolve(repoRoot);
  const dbDir = join(canonicalRoot, DB_DIR_NAME);
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }
  const dbPath = join(dbDir, DB_FILE_NAME);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  return db;
}
