/**
 * Register a repository for analysis.
 * Idempotent: registering an already-registered path returns the existing repo record.
 */

import { resolve } from 'node:path';
import { openDb, getDbPath } from '../db/connection.js';
import { findRepoByPath, insertRepo } from '../db/queries.js';
import { upsertRegistryEntry } from '../dashboard/registry.js';
import type { RegisterRepoOutput } from '../types.js';

export async function registerRepo(repoPath: string, name?: string): Promise<RegisterRepoOutput> {
  // Canonicalize the path
  const canonicalPath = resolve(repoPath);

  // Open DB (creates .mcp-sonar-analysis/db.sqlite if needed)
  const db = openDb(canonicalPath);

  try {
    // Check if already registered
    const existing = findRepoByPath(db, canonicalPath);
    if (existing) {
      // Upsert to global registry (self-healing for pre-feature repos)
      upsertRegistryEntry({
        repoId: existing.id,
        path: existing.path,
        name: existing.name,
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

    // New registration
    const created = insertRepo(db, canonicalPath, name);

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
