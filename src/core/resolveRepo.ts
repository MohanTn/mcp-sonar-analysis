/**
 * Resolve a numeric repoId or filesystem path to its registered repo record,
 * opening the per-repo SQLite DB at the canonical path. Shared by
 * analyseFile and getFileAnalysis.
 */

import { resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { openDb } from '../db/connection.js';
import { findRepoById, findRepoByPath } from '../db/queries.js';
import type { RepoRecord } from '../types.js';

export function resolveRepo(repoIdOrPath: number | string): { db: Database.Database; repo: RepoRecord } {
  const dbPath = typeof repoIdOrPath === 'string' ? resolve(repoIdOrPath) : process.cwd();
  let db = openDb(dbPath);

  try {
    if (typeof repoIdOrPath === 'number') {
      const found = findRepoById(db, repoIdOrPath);
      if (!found) {
        throw new Error(`Repo not found with ID: ${repoIdOrPath}. Make sure to call register_repo first or run from the registered repo directory.`);
      }
      return { db, repo: found };
    }

    const canonicalPath = resolve(repoIdOrPath);
    const found = findRepoByPath(db, canonicalPath);
    if (!found) {
      throw new Error('Repo not registered. Call register_repo first.');
    }
    // Close and reopen at the canonical path (may be different from the path we opened)
    if (canonicalPath !== dbPath) {
      db.close();
      db = openDb(canonicalPath);
    }
    return { db, repo: found };
  } catch (error) {
    db.close();
    throw error;
  }
}
