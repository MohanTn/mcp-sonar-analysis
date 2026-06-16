/**
 * Global repository registry module.
 * Manages ~/.mcp-sonar-analysis/registry.json for dashboard repo discovery.
 * See PRD-dashboard.md §6.3 for contract and guarantees.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RegistryEntry, RegistryFile } from '../types.js';

const DASHBOARD_HOME_DIR_NAME = '.mcp-sonar-analysis';
const REGISTRY_FILE_NAME = 'registry.json';

/**
 * Get the dashboard home directory (~/.mcp-sonar-analysis), creating it if needed.
 * Supports an optional override for testing, falling back to the
 * `MCP_SONAR_DASHBOARD_HOME` env var (used by tests that call through code
 * paths, like `registerRepo`, which don't accept an explicit override param).
 *
 * @param homeDirOverride - Optional override for the dashboard home directory (used in tests).
 *                          If provided, uses this instead of ~/.mcp-sonar-analysis.
 * @returns The dashboard home directory path.
 */
export function getDashboardHomeDir(homeDirOverride?: string): string {
  const baseDir =
    homeDirOverride || process.env.MCP_SONAR_DASHBOARD_HOME || join(homedir(), DASHBOARD_HOME_DIR_NAME);
  if (!existsSync(baseDir)) {
    mkdirSync(baseDir, { recursive: true });
  }
  return baseDir;
}

/**
 * Read the global registry file (~/.mcp-sonar-analysis/registry.json).
 * Returns { repos: [] } if missing or unparseable (logs warning, never throws).
 *
 * @param homeDirOverride - Optional override for the dashboard home directory (used in tests).
 * @returns The registry file contents.
 */
export function readRegistry(homeDirOverride?: string): RegistryFile {
  const homeDir = getDashboardHomeDir(homeDirOverride);
  const registryPath = join(homeDir, REGISTRY_FILE_NAME);

  if (!existsSync(registryPath)) {
    // File doesn't exist yet (fresh install or no repos registered) — return empty registry
    return { repos: [] };
  }

  try {
    const content = readFileSync(registryPath, 'utf-8');
    const parsed = JSON.parse(content) as RegistryFile;
    // Ensure it has a repos array
    if (!Array.isArray(parsed.repos)) {
      console.error(`Warning: registry.json has invalid structure (missing repos array), treating as empty`);
      return { repos: [] };
    }
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Warning: failed to read registry.json: ${message}`);
    return { repos: [] };
  }
}

/**
 * Find a registry entry by its globally-unique repoId.
 * Returns undefined if not found.
 */
export function findEntryByRepoId(repoId: number, homeDirOverride?: string): RegistryEntry | undefined {
  const registry = readRegistry(homeDirOverride);
  return registry.repos.find((r) => r.repoId === repoId);
}

/**
 * Find a registry entry by its canonical path.
 * Returns undefined if not found.
 */
export function findEntryByPath(repoPath: string, homeDirOverride?: string): RegistryEntry | undefined {
  const registry = readRegistry(homeDirOverride);
  return registry.repos.find((r) => r.path === repoPath);
}

/**
 * Compute the next globally-unique repoId by finding the maximum existing
 * repoId in the registry and adding 1. Returns 1 if the registry is empty.
 */
export function getNextGlobalRepoId(homeDirOverride?: string): number {
  const registry = readRegistry(homeDirOverride);
  if (registry.repos.length === 0) return 1;
  let maxId = 0;
  for (const repo of registry.repos) {
    if (repo.repoId > maxId) maxId = repo.repoId;
  }
  return maxId + 1;
}

/**
 * Remove a single entry from the registry by its canonical path.
 * Reads, modifies, and writes the entire registry.json file.
 * Never throws to the caller; logs errors to stderr and returns.
 *
 * @param repoPath - The canonical path of the repo to remove.
 * @param homeDirOverride - Optional override for the dashboard home directory (used in tests).
 */
export function removeRegistryEntry(repoPath: string, homeDirOverride?: string): void {
  try {
    const homeDir = getDashboardHomeDir(homeDirOverride);
    const registryPath = join(homeDir, REGISTRY_FILE_NAME);

    const registry = readRegistry(homeDirOverride);

    // Remove entry matching the path
    const newRepos = registry.repos.filter((repo) => repo.path !== repoPath);
    if (newRepos.length === registry.repos.length) {
      // No entry removed — repo wasn't in the registry
      return;
    }

    registry.repos = newRepos;
    writeFileSync(registryPath, JSON.stringify(registry, null, 2), 'utf-8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Warning: failed to remove registry entry: ${message}`);
  }
}

/**
 * Upsert a single entry into the registry (by path).
 * Reads, modifies, and writes the entire registry.json file.
 * Never throws to the caller; logs errors to stderr and returns.
 * See PRD-dashboard.md §6.3 for idempotency and concurrency notes.
 *
 * @param entry - The registry entry to upsert.
 * @param homeDirOverride - Optional override for the dashboard home directory (used in tests).
 */
export function upsertRegistryEntry(entry: RegistryEntry, homeDirOverride?: string): void {
  try {
    const homeDir = getDashboardHomeDir(homeDirOverride);
    const registryPath = join(homeDir, REGISTRY_FILE_NAME);

    // Read current registry
    const registry = readRegistry(homeDirOverride);

    // Upsert by path: find and replace if exists, else append
    const existingIndex = registry.repos.findIndex((repo) => repo.path === entry.path);
    if (existingIndex >= 0) {
      registry.repos[existingIndex] = entry;
    } else {
      registry.repos.push(entry);
    }

    // Write back to disk
    writeFileSync(registryPath, JSON.stringify(registry, null, 2), 'utf-8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Warning: failed to upsert registry entry: ${message}`);
  }
}
