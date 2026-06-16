/**
 * Resolve a numeric repoId or filesystem path to its registered repo record,
 * opening the per-repo SQLite DB at the canonical path. Shared by
 * analyseFile and getFileAnalysis.
 *
 * When given a numeric repoId, consults the global registry to find the
 * repo's filesystem path, then opens the DB at that path. Falls back to
 * opening the DB from process.cwd() if the registry lookup fails.
 */

import { resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { openDb } from '../db/connection.js';
import { findRepoById, findRepoByPath } from '../db/queries.js';
import { findEntryByRepoId } from '../dashboard/registry.js';
import type { RepoRecord } from '../types.js';

export function resolveRepo(repoIdOrPath: number | string): { db: Database.Database; repo: RepoRecord } {
  if (typeof repoIdOrPath === 'number') {
    // Look up the repo's path from the global registry
    const registryEntry = findEntryByRepoId(repoIdOrPath);
    let dbPath: string;
    if (registryEntry) {
      dbPath = registryEntry.path;
    } else {
      // Fallback: open from cwd (for backwards compatibility)
      dbPath = process.cwd();
    }

    const db = openDb(dbPath);
    try {
      const found = findRepoById(db, repoIdOrPath);
      if (!found) {
        throw new Error(
          `Repo not found with ID: ${repoIdOrPath}. Make sure to call register_repo first or run from the registered repo directory.`,
        );
      }
      return { db, repo: found };
    } catch (error) {
      db.close();
      throw error;
    }
  }

  // String path: resolve and look up by path
  const canonicalPath = resolve(repoIdOrPath);
  let db = openDb(canonicalPath);

  try {
    const found = findRepoByPath(db, canonicalPath);
    if (!found) {
      throw new Error('Repo not registered. Call register_repo first.');
    }
    return { db, repo: found };
  } catch (error) {
    db.close();
    throw error;
  }
}
