/**
 * API handlers for the dashboard HTTP server.
 * Provides read-only endpoints for repo listing, summaries, and file analysis.
 * See PRD-dashboard.md §6.8 for contract specifications.
 */

import * as http from 'node:http';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { readRegistry } from './registry.js';
import { openDb, getDbPath } from '../db/connection.js';
import {
  findRepoByPath,
  countIssuesByType,
  countIssuesBySeverity,
  countIssuesByTypeAndSeverity,
  listFilesWithIssueCounts,
} from '../db/queries.js';
import { getFileAnalysis } from '../core/getFileAnalysis.js';

/**
 * GET /api/repos
 * List all registered repositories with their issue counts.
 */
export async function handleListRepos(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return;
  }

  try {
    const registry = readRegistry();
    const repos = [];

    for (const entry of registry.repos) {
      const repoData: Record<string, unknown> = {
        path: entry.path,
        name: entry.name,
        registeredAt: entry.registeredAt,
        lastAnalyzedAt: null,
        status: 'pending',
      };

      // Check if DB file exists
      const dbPath = getDbPath(entry.path);
      if (!existsSync(dbPath)) {
        repoData.stale = true;
      } else {
        repoData.stale = false;
        // Open DB and get issue counts
        try {
          const db = openDb(entry.path);
          try {
            const repo = findRepoByPath(db, entry.path);
            if (repo) {
              const issuesByType = countIssuesByType(db, repo.id);
              repoData.issuesByType = issuesByType;
              repoData.lastAnalyzedAt = repo.lastAnalyzedAt ?? null;
              repoData.status = repo.status;
            }
          } finally {
            db.close();
          }
        } catch (error) {
          console.error(`Failed to open DB for ${entry.path}:`, error);
          repoData.stale = true;
        }
      }

      repos.push(repoData);
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ repos }));
  } catch (error) {
    console.error('Failed to list repos:', error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'internal server error' }));
  }
}

/**
 * GET /api/repos/:path/summary
 * Get a summary of a specific repository including issue counts and file list.
 */
export async function handleRepoSummary(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  repoPath: string,
): Promise<void> {
  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return;
  }

  try {
    const resolvedPath = resolve(repoPath);

    // Check if repo is in registry
    const registry = readRegistry();
    const registryEntry = registry.repos.find((r) => r.path === resolvedPath);
    if (!registryEntry) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'repo not found' }));
      return;
    }

    // Open DB and check if repo exists
    const db = openDb(resolvedPath);
    try {
      const repo = findRepoByPath(db, resolvedPath);
      if (!repo) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'repo not analyzed' }));
        return;
      }

      const issuesByType = countIssuesByType(db, repo.id);
      const issuesBySeverity = countIssuesBySeverity(db, repo.id);
      const issuesByTypeAndSeverity = countIssuesByTypeAndSeverity(db, repo.id);
      const filesWithIssueCounts = listFilesWithIssueCounts(db, repo.id);

      const summary = {
        path: repo.path,
        status: repo.status,
        lastAnalyzedAt: repo.lastAnalyzedAt,
        issuesByType,
        issuesBySeverity,
        issuesByTypeAndSeverity,
        files: filesWithIssueCounts.map((f) => ({
          filePath: f.filePath,
          issueCount: f.issueCount,
        })),
      };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(summary));
    } finally {
      db.close();
    }
  } catch (error) {
    console.error('Failed to get repo summary:', error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'internal server error' }));
  }
}

/**
 * GET /api/repos/:path/files/*filePath
 * Get analysis results for a specific file.
 */
export async function handleFileAnalysis(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  repoPath: string,
  filePath: string,
): Promise<void> {
  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return;
  }

  try {
    const resolvedPath = resolve(repoPath);
    const resolvedFilePath = resolve(resolvedPath, filePath);

    // Reject if filePath contains .. segments (defense in depth)
    if (filePath.includes('..')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid file path' }));
      return;
    }

    // Call getFileAnalysis directly
    const analysis = await getFileAnalysis(resolvedPath, resolvedFilePath);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(analysis));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('Repo not registered') || message.includes('not found')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    } else {
      console.error('Failed to get file analysis:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal server error' }));
    }
  }
}
