/**
 * API handlers for the dashboard HTTP server.
 * Provides read-only endpoints for repo listing, summaries, and file analysis.
 * See PRD-dashboard.md §6.8 for contract specifications.
 */

import * as http from 'node:http';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { readRegistry, removeRegistryEntry } from './registry.js';
import { openDb, getDbPath } from '../db/connection.js';
import {
  findRepoByPath,
  countIssuesByType,
  countIssuesBySeverity,
  countIssuesByTypeAndSeverity,
  listFilesWithIssueCounts,
  getAllDependencies,
  getAllSourceFiles,
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
 * DELETE /api/repos/:path
 * Remove a repository from the global registry.
 * Does NOT delete the per-repo .mcp-sonar-analysis/ directory or DB file.
 */
export async function handleDeleteRepo(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  repoPath: string,
): Promise<void> {
  if (req.method !== 'DELETE') {
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

    removeRegistryEntry(resolvedPath);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, path: resolvedPath }));
  } catch (error) {
    console.error('Failed to delete repo:', error);
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
/**
 * GET /api/repos/:path/dependencies
 * Get all dependency edges for a repo's dependency graph visualization.
 */
export async function handleRepoDependencies(
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

    const db = openDb(resolvedPath);
    try {
      const repo = findRepoByPath(db, resolvedPath);
      if (!repo) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'repo not analyzed' }));
        return;
      }

      // Get all edges and source files
      const edges = getAllDependencies(db, repo.id);
      const allFiles = getAllSourceFiles(db, repo.id);

      // Compute degree per node
      const inDegree = new Map<string, number>();
      const outDegree = new Map<string, number>();
      for (const f of allFiles) {
        inDegree.set(f, 0);
        outDegree.set(f, 0);
      }
      for (const edge of edges) {
        outDegree.set(edge.sourceFile, (outDegree.get(edge.sourceFile) || 0) + 1);
        if (edge.importedFile) {
          inDegree.set(edge.importedFile, (inDegree.get(edge.importedFile) || 0) + 1);
        }
      }

      // Detect language per file (from edges, with fallback to file extension)
      const fileLanguage = new Map<string, string>();
      for (const edge of edges) {
        if (!fileLanguage.has(edge.sourceFile)) {
          fileLanguage.set(edge.sourceFile, edge.language);
        }
      }
      for (const f of allFiles) {
        if (!fileLanguage.has(f)) {
          fileLanguage.set(f, f.endsWith('.cs') ? 'csharp' : 'typescript');
        }
      }

      const nodes = allFiles.map((filePath) => ({
        id: filePath,
        language: fileLanguage.get(filePath) || 'unknown',
        baseName: filePath.split('/').pop() || filePath,
        inDegree: inDegree.get(filePath) || 0,
        outDegree: outDegree.get(filePath) || 0,
      }));

      const graphEdges = edges.map((e) => ({
        source: e.sourceFile,
        target: e.importedFile || e.importedModule,
        resolved: e.resolved,
        language: e.language,
        label: e.importedModule,
      }));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ nodes, edges: graphEdges }));
    } finally {
      db.close();
    }
  } catch (error) {
    console.error('Failed to get repo dependencies:', error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'internal server error' }));
  }
}

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
