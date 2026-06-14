/**
 * Analyse a full repository.
 * Discovers all *.ts, *.tsx, *.cs files, runs analyzers, persists results.
 */

import { resolve, relative } from 'node:path';
import { stat } from 'node:fs/promises';
import type Database from 'better-sqlite3';
import { globby } from 'globby';
import { openDb } from '../db/connection.js';
import {
  findRepoById,
  findRepoByPath,
  updateRepoStatus,
  upsertFileIssues,
  upsertFileDependencies,
  countIssuesByType,
  countDependencies,
  recordAnalysisRun,
  getFileMtime,
  setFileMtime,
} from '../db/queries.js';
import { runTypeScriptAnalyzer } from '../analyzers/typescript.js';
import { runTsDependencyGraph } from '../analyzers/dependency-graph-ts.js';
import { findCsprojFiles, runCsharpAnalyzer } from '../analyzers/csharp.js';
import { runCsDependencyGraph } from '../analyzers/dependency-graph-cs.js';
import { isPathInside } from '../util/paths.js';
import type { AnalyseRepoOutput, RepoRecord } from '../types.js';

// ---------------------------------------------------------------------------
// Helper: resolve or open the database and look up the repo record
// ---------------------------------------------------------------------------

async function resolveRepoRecord(
  repoIdOrPath: number | string,
): Promise<{ db: Database.Database; repo: RepoRecord }> {
  const dbPath = typeof repoIdOrPath === 'string' ? resolve(repoIdOrPath) : process.cwd();
  let db = openDb(dbPath);
  let repo: RepoRecord;

  try {
    if (typeof repoIdOrPath === 'number') {
      const found = findRepoById(db, repoIdOrPath);
      if (!found) {
        throw new Error(
          `Repo not found with ID: ${repoIdOrPath}. Make sure to call register_repo first or run from the registered repo directory.`,
        );
      }
      repo = found;
    } else {
      const canonicalPath = resolve(repoIdOrPath);
      const found = findRepoByPath(db, canonicalPath);
      if (!found) {
        throw new Error('Repo not registered. Call register_repo first.');
      }
      repo = found;
      if (canonicalPath !== dbPath) {
        db.close();
        db = openDb(canonicalPath);
      }
    }
  } catch (error) {
    db.close();
    throw error;
  }

  return { db, repo };
}

// ---------------------------------------------------------------------------
// Helpers: incremental analysis (S1) — mtime-based file partitioning
// ---------------------------------------------------------------------------

/**
 * Partition a list of files into those that have changed (mtime differs from
 * stored value) and those that haven't. When `force` is true every file is
 * considered changed.
 */
async function partitionFilesByMtime(
  files: string[],
  repoPath: string,
  db: Database.Database,
  repoId: number,
  force?: boolean,
): Promise<{ changed: string[]; unchanged: string[] }> {
  if (force) {
    return { changed: files, unchanged: [] };
  }

  const changed: string[] = [];
  const unchanged: string[] = [];

  for (const relPath of files) {
    const absPath = resolve(repoPath, relPath);
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(absPath)).mtimeMs;
    } catch {
      changed.push(relPath);
      continue;
    }
    const stored = getFileMtime(db, repoId, relPath);
    if (stored !== undefined && stored === mtimeMs) {
      unchanged.push(relPath);
    } else {
      changed.push(relPath);
    }
  }

  return { changed, unchanged };
}

/** Record the current mtime for each file so future runs can skip it. */
async function recordFileMtimes(
  files: string[],
  repoPath: string,
  db: Database.Database,
  repoId: number,
): Promise<void> {
  for (const relPath of files) {
    try {
      const mtimeMs = (await stat(resolve(repoPath, relPath))).mtimeMs;
      setFileMtime(db, repoId, relPath, mtimeMs);
    } catch {
      // File disappeared; nothing to record.
    }
  }
}

// ---------------------------------------------------------------------------
// Helper: discover source files
// ---------------------------------------------------------------------------

async function discoverSourceFiles(
  repoPath: string,
): Promise<{ tsFiles: string[]; csFiles: string[] }> {
  const allFiles = await globby(
    ['**/*.ts', '**/*.tsx', '**/*.cs'],
    {
      cwd: repoPath,
      gitignore: true,
      ignore: ['node_modules', 'bin', 'obj', 'dist', 'build', '.git', '.mcp-sonar-analysis'],
    },
  );

  return {
    tsFiles: allFiles.filter((f) => f.endsWith('.ts') || f.endsWith('.tsx')),
    csFiles: allFiles.filter((f) => f.endsWith('.cs')),
  };
}

// ---------------------------------------------------------------------------
// Helper: normalize a dependency edge path to be repo-relative
// ---------------------------------------------------------------------------

/**
 * Normalize a file path to be relative to the repo root.
 * - Absolute paths are relativized.
 * - CWD-relative paths that fall inside the repo are also relativized.
 * - Other paths are returned as-is.
 */
function normalizeEdgePath(filePath: string, repoPath: string): string {
  if (filePath.startsWith('/')) {
    return relative(repoPath, filePath);
  }
  const possibleAbs = resolve(filePath);
  if (isPathInside(possibleAbs, repoPath)) {
    return relative(repoPath, possibleAbs);
  }
  return filePath;
}

// ---------------------------------------------------------------------------
// TypeScript analysis helpers
// ---------------------------------------------------------------------------

/** Run the TypeScript/TSX analyzer on the given (changed) files and persist results. */
async function analyseTypeScriptSources(
  files: string[],
  repoPath: string,
  db: Database.Database,
  repoId: number,
): Promise<number> {
  if (files.length === 0) return 0;

  const absPaths = files.map((f) => resolve(repoPath, f));
  const tsIssuesMap = await runTypeScriptAnalyzer(absPaths, repoPath);
  let count = 0;

  for (const [absPath, issues] of tsIssuesMap) {
    const relPath = relative(repoPath, absPath);
    upsertFileIssues(db, repoId, relPath, issues);
    count += issues.length;
  }

  await recordFileMtimes(files, repoPath, db, repoId);
  return count;
}

/** Process the TypeScript dependency graph and persist edges. */
async function processTypeScriptDependencies(
  files: string[],
  repoPath: string,
  db: Database.Database,
  repoId: number,
): Promise<void> {
  if (files.length === 0) return;

  const absPaths = files.map((f) => resolve(repoPath, f));
  const tsEdges = await runTsDependencyGraph(absPaths, repoPath);

  const edgesBySource = new Map<string, typeof tsEdges>();
  for (const edge of tsEdges) {
    const sourceRel = normalizeEdgePath(edge.sourceFile, repoPath);
    const importedRel = edge.importedFile ? normalizeEdgePath(edge.importedFile, repoPath) : undefined;
    const normalizedEdge = { ...edge, sourceFile: sourceRel, importedFile: importedRel };

    if (!edgesBySource.has(sourceRel)) {
      edgesBySource.set(sourceRel, []);
    }
    edgesBySource.get(sourceRel)!.push(normalizedEdge);
  }

  for (const [sourceFile, edges] of edgesBySource) {
    upsertFileDependencies(db, repoId, sourceFile, edges);
  }

  for (const relPath of files) {
    if (!edgesBySource.has(relPath)) {
      upsertFileDependencies(db, repoId, relPath, []);
    }
  }
}

// ---------------------------------------------------------------------------
// C# analysis helpers
// ---------------------------------------------------------------------------

/**
 * Run the C# analyzer (dotnet build + SARIF parse) on the given (changed)
 * .cs files and persist results.  Returns the total issue count and any
 * errors encountered.
 */
async function analyseCSharpSources(
  changedFiles: string[],
  allFiles: string[],
  repoPath: string,
  db: Database.Database,
  repoId: number,
): Promise<{ count: number; errors: string[] }> {
  const errors: string[] = [];
  if (allFiles.length === 0) return { count: 0, errors };

  const csprojPaths = await findCsprojFiles(repoPath);
  if (csprojPaths.length === 0) {
    errors.push('C# files found but no .csproj files detected — skipping C# analysis');
    return { count: 0, errors };
  }

  if (changedFiles.length === 0) return { count: 0, errors };

  const { issuesByFile, errors: csErrors } = await runCsharpAnalyzer(csprojPaths, repoPath);
  let count = 0;

  for (const [filePath, issues] of issuesByFile) {
    let relPath: string;
    if (isPathInside(filePath, repoPath)) {
      relPath = relative(repoPath, filePath);
    } else if (filePath.startsWith('/')) {
      relPath = filePath.slice(1);
    } else {
      relPath = filePath;
    }
    upsertFileIssues(db, repoId, relPath, issues);
    count += issues.length;
  }

  errors.push(...csErrors);
  await recordFileMtimes(changedFiles, repoPath, db, repoId);
  return { count, errors };
}

/** Process the C# dependency graph (using-directive scan) and persist edges. */
async function processCSharpDependencies(
  files: string[],
  repoPath: string,
  db: Database.Database,
  repoId: number,
): Promise<void> {
  if (files.length === 0) return;

  const absPaths = files.map((f) => resolve(repoPath, f));
  const csEdges = await runCsDependencyGraph(absPaths, repoPath);

  const edgesBySource = new Map<string, typeof csEdges>();
  for (const edge of csEdges) {
    const sourceRel = relative(repoPath, edge.sourceFile);
    const importedRel = edge.importedFile ?? undefined;
    const normalizedEdge = { ...edge, sourceFile: sourceRel, importedFile: importedRel };

    if (!edgesBySource.has(sourceRel)) {
      edgesBySource.set(sourceRel, []);
    }
    edgesBySource.get(sourceRel)!.push(normalizedEdge);
  }

  for (const [sourceFile, edges] of edgesBySource) {
    upsertFileDependencies(db, repoId, sourceFile, edges);
  }

  for (const relPath of files) {
    if (!edgesBySource.has(relPath)) {
      upsertFileDependencies(db, repoId, relPath, []);
    }
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function analyseRepo(
  repoIdOrPath: number | string,
  opts?: { force?: boolean },
): Promise<AnalyseRepoOutput> {
  const startTime = new Date();
  const { db, repo } = await resolveRepoRecord(repoIdOrPath);

  try {
    updateRepoStatus(db, repo.id, 'in_progress');

    const { tsFiles, csFiles } = await discoverSourceFiles(repo.path);
    const errors: string[] = [];

    // S1: incremental — skip unchanged files unless --force
    const { changed: tsChanged } = await partitionFilesByMtime(
      tsFiles, repo.path, db, repo.id, opts?.force,
    );
    const { changed: csChanged } = await partitionFilesByMtime(
      csFiles, repo.path, db, repo.id, opts?.force,
    );

    // TypeScript analysis + mtime recording
    const tsIssuesCount = await analyseTypeScriptSources(tsChanged, repo.path, db, repo.id);

    // TS dependency graph (runs on full file set — cheap, graph-wide)
    await processTypeScriptDependencies(tsFiles, repo.path, db, repo.id);

    // C# analysis + mtime recording
    const { count: csIssuesCount, errors: csErrors } = await analyseCSharpSources(
      csChanged, csFiles, repo.path, db, repo.id,
    );
    errors.push(...csErrors);

    // C# dependency graph (regex-based, no dotnet SDK required)
    await processCSharpDependencies(csFiles, repo.path, db, repo.id);

    // Compute statistics
    const issuesByType = countIssuesByType(db, repo.id);
    const dependenciesFound = countDependencies(db, repo.id);
    const filesAnalyzed = tsFiles.length + csFiles.length;

    const endTime = new Date();
    const durationMs = endTime.getTime() - startTime.getTime();

    updateRepoStatus(db, repo.id, 'success', endTime.toISOString());
    recordAnalysisRun(db, {
      repoId: repo.id,
      runType: 'full_repo',
      startedAt: startTime.toISOString(),
      completedAt: endTime.toISOString(),
      durationMs,
      filesAnalyzed,
      issuesFound: tsIssuesCount + csIssuesCount,
      errorMessage: errors.length > 0 ? errors.join('; ') : undefined,
    });

    return {
      repoId: repo.id,
      filesAnalyzed,
      issuesByType,
      dependenciesFound,
      durationMs,
      errors,
    };
  } finally {
    db.close();
  }
}
