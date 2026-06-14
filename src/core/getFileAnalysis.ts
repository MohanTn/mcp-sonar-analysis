/**
 * Get analysis results for a single file (read-only).
 * Returns persisted issues, dependencies, and analysis status.
 */

import type Database from 'better-sqlite3';
import { getFileIssues, getFileDependencies, getReverseDependencies, hasFileBeenAnalyzed } from '../db/queries.js';
import { resolveRepo } from './resolveRepo.js';
import { normalizeRelFilePath, detectLanguage } from '../util/paths.js';
import type { GetFileAnalysisOutput, IssueSeverity, IssueType } from '../types.js';

/** Most recent analyzed_at across this file's issue and dependency rows. */
function getLastAnalyzedAt(db: Database.Database, repoId: number, relFilePath: string): string | undefined {
  const issueRows = db
    .prepare('SELECT analyzed_at FROM file_issues WHERE repo_id = ? AND file_path = ? ORDER BY analyzed_at DESC LIMIT 1')
    .all(repoId, relFilePath) as Array<{ analyzed_at: string }>;

  const depRows = db
    .prepare('SELECT analyzed_at FROM file_dependencies WHERE repo_id = ? AND source_file = ? ORDER BY analyzed_at DESC LIMIT 1')
    .all(repoId, relFilePath) as Array<{ analyzed_at: string }>;

  const timestamps = [...issueRows.map((r) => r.analyzed_at), ...depRows.map((r) => r.analyzed_at)];
  return timestamps.length > 0 ? timestamps.sort().reverse()[0] : undefined;
}

export async function getFileAnalysis(
  repoIdOrPath: number | string,
  filePath: string,
  opts?: { type?: IssueType; severity?: IssueSeverity },
): Promise<GetFileAnalysisOutput> {
  const { db, repo } = resolveRepo(repoIdOrPath);

  try {
    const relFilePath = normalizeRelFilePath(filePath, repo.path);
    const language = detectLanguage(relFilePath);

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

    const lastAnalyzedAt = analyzed ? getLastAnalyzedAt(db, repo.id, relFilePath) : undefined;

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
