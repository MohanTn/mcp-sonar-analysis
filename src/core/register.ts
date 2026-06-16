/**
 * Register a repository for analysis.
 * Idempotent: registering an already-registered path returns the existing repo record.
 *
 * repoIds are globally unique across all repos, assigned from the global
 * registry (~/.mcp-sonar-analysis/registry.json). The per-repo SQLite DB
 * stores the same global ID so foreign-key relationships stay consistent.
 */

import { resolve } from 'node:path';
import { openDb, getDbPath } from '../db/connection.js';
import { findRepoByPath, insertRepo } from '../db/queries.js';
import {
  upsertRegistryEntry,
  findEntryByPath,
  getNextGlobalRepoId,
} from '../dashboard/registry.js';
import type { RegisterRepoOutput } from '../types.js';

export async function registerRepo(repoPath: string, name?: string): Promise<RegisterRepoOutput> {
  // Canonicalize the path
  const canonicalPath = resolve(repoPath);

  // Open DB (creates .mcp-sonar-analysis/db.sqlite if needed)
  const db = openDb(canonicalPath);

  try {
    // Check if already registered in the local DB
    const existing = findRepoByPath(db, canonicalPath);
    if (existing) {
      // Self-heal: ensure the registry entry matches the local DB (which
      // is the source of truth). If the registry has a stale repoId for
      // this path, the upsert corrects it.
      upsertRegistryEntry({
        repoId: existing.id,
        path: existing.path,
        name: existing.name ?? name ?? null,
        dbPath: getDbPath(canonicalPath),
        registeredAt: existing.registeredAt,
      });

      return {
        repoId: existing.id,
        path: existing.path,
        registeredAt: existing.registeredAt,
        alreadyRegistered: true,
        status: existing.status,
      };
    }

    // ---- New registration ----
    // Check the global registry first: if this path was previously
    // registered but the local DB was deleted, reuse the old repoId.
    const existingRegistryEntry = findEntryByPath(canonicalPath);
    let newRepoId: number;
    if (existingRegistryEntry) {
      newRepoId = existingRegistryEntry.repoId;
    } else {
      newRepoId = getNextGlobalRepoId();
    }

    // Insert with the globally-unique repoId
    const created = insertRepo(db, canonicalPath, name, newRepoId);

    // Upsert to global registry
    upsertRegistryEntry({
      repoId: created.id,
      path: created.path,
      name: created.name,
      dbPath: getDbPath(canonicalPath),
      registeredAt: created.registeredAt,
    });

    return {
      repoId: created.id,
      path: created.path,
      registeredAt: created.registeredAt,
      alreadyRegistered: false,
      status: created.status,
    };
  } finally {
    // Close DB handle (short-lived per PRD §6.7)
    db.close();
  }
}
