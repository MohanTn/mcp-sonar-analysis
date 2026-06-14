/**
 * Get analysis results for a single file (read-only).
 * Returns persisted issues, dependencies, and analysis status.
 */

import { resolve, relative } from 'node:path';
import { openDb } from '../db/connection.js';
import { findRepoById, findRepoByPath, getFileIssues, getFileDependencies, getReverseDependencies, hasFileBeenAnalyzed } from '../db/queries.js';
import type { GetFileAnalysisOutput, FileLanguage, IssueSeverity, IssueType, RepoRecord } from '../types.js';

export async function getFileAnalysis(
  repoIdOrPath: number | string,
  filePath: string,
  opts?: { type?: IssueType; severity?: IssueSeverity },
): Promise<GetFileAnalysisOutput> {
  // Resolve repo: try to open DB and find the repo record
  const dbPath = typeof repoIdOrPath === 'string' ? resolve(repoIdOrPath) : process.cwd();
  let db = openDb(dbPath);
  let repo: RepoRecord | null = null;

  try {
    if (typeof repoIdOrPath === 'number') {
      const found = findRepoById(db, repoIdOrPath);
      if (!found) {
        throw new Error(`Repo not found with ID: ${repoIdOrPath}. Make sure to call register_repo first or run from the registered repo directory.`);
      }
      repo = found;
    } else {
      const canonicalPath = resolve(repoIdOrPath);
      const found = findRepoByPath(db, canonicalPath);
      if (!found) {
        throw new Error('Repo not registered. Call register_repo first.');
      }
      repo = found;
      // Close and reopen at the canonical path (may be different from the path we opened)
      if (canonicalPath !== dbPath) {
        db.close();
        db = openDb(canonicalPath);
      }
    }

    // Normalize file path to repo-relative
    const relFilePath = filePath.startsWith(repo.path)
      ? relative(repo.path, filePath)
      : filePath.startsWith('/')
        ? filePath.slice(1)
        : filePath;

    // Determine language by extension
    const language: FileLanguage = relFilePath.endsWith('.ts') || relFilePath.endsWith('.tsx')
      ? 'typescript'
      : relFilePath.endsWith('.cs')
        ? 'csharp'
        : 'unknown';

    // Check if analyzed
    const analyzed = hasFileBeenAnalyzed(db, repo.id, relFilePath);

    // Get issues with optional filtering
    let issues = getFileIssues(db, repo.id, relFilePath);
    if (opts?.type) {
      issues = issues.filter((i) => i.type === opts.type);
    }
    if (opts?.severity) {
      issues = issues.filter((i) => i.severity === opts.severity);
    }

    // Get dependencies
    const deps = getFileDependencies(db, repo.id, relFilePath);
    const dependsOn = deps.map((e) => ({
      module: e.importedModule,
      resolvedFile: e.importedFile,
    }));

    const dependedOnBy = getReverseDependencies(db, repo.id, relFilePath);

    // Get last analyzed time from the most recent issue or dependency
    let lastAnalyzedAt: string | undefined = undefined;
    if (analyzed) {
      // Query the most recent analyzed_at from file_issues or file_dependencies
      const issueRows = db
        .prepare(
          'SELECT analyzed_at FROM file_issues WHERE repo_id = ? AND file_path = ? ORDER BY analyzed_at DESC LIMIT 1',
        )
        .all(repo.id, relFilePath) as Array<{ analyzed_at: string }>;

      const depRows = db
        .prepare(
          'SELECT analyzed_at FROM file_dependencies WHERE repo_id = ? AND source_file = ? ORDER BY analyzed_at DESC LIMIT 1',
        )
        .all(repo.id, relFilePath) as Array<{ analyzed_at: string }>;

      const timestamps = [
        ...(issueRows.map((r) => r.analyzed_at) ?? []),
        ...(depRows.map((r) => r.analyzed_at) ?? []),
      ];
      if (timestamps.length > 0) {
        // Get the most recent timestamp
        lastAnalyzedAt = timestamps.sort().reverse()[0];
      }
    }

    return {
      filePath: relFilePath,
      language,
      analyzed,
      lastAnalyzedAt,
      issues,
      dependsOn,
      dependedOnBy,
    };
  } finally {
    db.close();
  }
}
