/**
 * Analyse a single file and refresh its results.
 * Runs the appropriate analyzer, upserts issues and dependencies, returns fresh analysis.
 */

import { resolve, relative, dirname } from 'node:path';
import { stat } from 'node:fs/promises';
import type Database from 'better-sqlite3';
import { upsertFileIssues, upsertFileDependencies, recordAnalysisRun, setFileMtime } from '../db/queries.js';
import { runTypeScriptAnalyzer } from '../analyzers/typescript.js';
import { runTsDependencyGraph } from '../analyzers/dependency-graph-ts.js';
import { findCsprojFiles, runCsharpAnalyzerForFile } from '../analyzers/csharp.js';
import { runCsDependencyGraph } from '../analyzers/dependency-graph-cs.js';
import { getFileAnalysis } from './getFileAnalysis.js';
import { resolveRepo } from './resolveRepo.js';
import { isPathInside, normalizeRelFilePath, detectLanguage } from '../util/paths.js';
import type { AnalyseFileOutput, IssueSeverity, IssueType, RepoRecord, Issue, DependencyEdge } from '../types.js';

/**
 * Find the .csproj file that contains (or is an ancestor of) the given file.
 * Returns the closest .csproj path, or undefined if not found.
 */
async function findContainingCsproj(absFilePath: string, repoRoot: string): Promise<string | undefined> {
  const csprojPaths = await findCsprojFiles(repoRoot);

  // Get the directory of the file
  const fileDir = dirname(absFilePath);

  // Find the closest csproj (longest matching ancestor directory)
  let closest: string | undefined = undefined;
  let closestDepth = -1;

  for (const csproj of csprojPaths) {
    const csprojDir = dirname(csproj);
    // Check if csprojDir is an ancestor of (or equal to) fileDir
    if (isPathInside(fileDir, csprojDir)) {
      const depth = csprojDir.split('/').length;
      if (depth > closestDepth) {
        closest = csproj;
        closestDepth = depth;
      }
    }
  }

  return closest;
}

/** Normalize a dependency-graph edge path to be repo-relative, same logic as analyseRepo. */
function normalizeEdgePath(path: string, repoRoot: string): string {
  if (path.startsWith('/')) {
    return relative(repoRoot, path);
  }
  const possibleAbs = resolve(path);
  return isPathInside(possibleAbs, repoRoot) ? relative(repoRoot, possibleAbs) : path;
}

function normalizeDependencyEdges(edges: DependencyEdge[], repoRoot: string): DependencyEdge[] {
  return edges.map((edge) => ({
    ...edge,
    sourceFile: normalizeEdgePath(edge.sourceFile, repoRoot),
    importedFile: edge.importedFile ? normalizeEdgePath(edge.importedFile, repoRoot) : edge.importedFile,
  }));
}

async function analyseTypeScriptFile(
  db: Database.Database,
  repo: RepoRecord,
  absFilePath: string,
  relFilePath: string,
): Promise<Issue[]> {
  const tsIssuesMap = await runTypeScriptAnalyzer([absFilePath], repo.path);
  const issues = tsIssuesMap.get(absFilePath) ?? [];

  const tsEdges = await runTsDependencyGraph([absFilePath], repo.path);
  const normalizedEdges = normalizeDependencyEdges(tsEdges, repo.path);
  upsertFileDependencies(db, repo.id, relFilePath, normalizedEdges);

  return issues;
}

/**
 * A `dotnet build` of the containing project produces diagnostics for ALL
 * files in that project; pick out only the entry for this file. SARIF
 * artifactLocation.uri may be repo-relative, project-relative, or absolute
 * depending on the toolchain, so match defensively by comparing normalized
 * (repo-relative) paths.
 */
function findIssuesForFile(
  issuesByFile: Map<string, Issue[]>,
  repoRoot: string,
  relFilePath: string,
  absFilePath: string,
): Issue[] {
  for (const [sarifPath, fileIssues] of issuesByFile) {
    const normalizedSarifPath = isPathInside(sarifPath, repoRoot)
      ? relative(repoRoot, sarifPath)
      : sarifPath.replace(/^\/+/, '');
    if (normalizedSarifPath === relFilePath || sarifPath === absFilePath) {
      return fileIssues;
    }
  }
  return [];
}

async function analyseCSharpFile(
  db: Database.Database,
  repo: RepoRecord,
  absFilePath: string,
  relFilePath: string,
): Promise<{ issues: Issue[]; errors: string[] }> {
  const errors: string[] = [];
  let issues: Issue[] = [];

  const csproj = await findContainingCsproj(absFilePath, repo.path);
  if (!csproj) {
    errors.push(`No .csproj file found for ${relFilePath}`);
  } else {
    const { issuesByFile, errors: csErrors } = await runCsharpAnalyzerForFile(csproj, repo.path);
    errors.push(...csErrors);
    issues = findIssuesForFile(issuesByFile, repo.path, relFilePath, absFilePath);
  }

  // C# dependency graph for this file
  const csEdges = await runCsDependencyGraph([absFilePath], repo.path);
  const normalizedCsEdges: DependencyEdge[] = csEdges.map((edge) => ({
    ...edge,
    sourceFile: relative(repo.path, edge.sourceFile),
    importedFile: edge.importedFile ?? undefined,
  }));
  upsertFileDependencies(db, repo.id, relFilePath, normalizedCsEdges);

  return { issues, errors };
}

export async function analyseFile(
  repoIdOrPath: number | string,
  filePath: string,
  opts?: { type?: IssueType; severity?: IssueSeverity },
): Promise<AnalyseFileOutput> {
  const startTime = new Date();
  const { db, repo } = resolveRepo(repoIdOrPath);

  try {
    const relFilePath = normalizeRelFilePath(filePath, repo.path);
    const absFilePath = resolve(repo.path, relFilePath);
    const language = detectLanguage(relFilePath);

    const errors: string[] = [];
    let issues: Issue[] = [];

    if (language === 'typescript') {
      issues = await analyseTypeScriptFile(db, repo, absFilePath, relFilePath);
    } else if (language === 'csharp') {
      const result = await analyseCSharpFile(db, repo, absFilePath, relFilePath);
      issues = result.issues;
      errors.push(...result.errors);
    } else {
      errors.push(`Unsupported file type: ${language}`);
    }

    // Upsert issues
    upsertFileIssues(db, repo.id, relFilePath, issues);

    // Record this file's current mtime (S1: keeps analyse_repo's incremental
    // skip in sync with out-of-band single-file analyses, e.g. via hooks).
    try {
      const mtimeMs = (await stat(absFilePath)).mtimeMs;
      setFileMtime(db, repo.id, relFilePath, mtimeMs);
    } catch {
      // File may have been deleted between analysis and this point; ignore.
    }

    const endTime = new Date();
    const durationMs = endTime.getTime() - startTime.getTime();

    // Record analysis run
    recordAnalysisRun(db, {
      repoId: repo.id,
      runType: 'single_file',
      filePath: relFilePath,
      startedAt: startTime.toISOString(),
      completedAt: endTime.toISOString(),
      durationMs,
      filesAnalyzed: 1,
      issuesFound: issues.length,
      errorMessage: errors.length > 0 ? errors.join('; ') : undefined,
    });

    // Read back via getFileAnalysis (use repo path to avoid needing global DB)
    db.close();
    const analysis = await getFileAnalysis(repo.path, relFilePath, opts);

    return {
      ...analysis,
      durationMs,
      analyzedAt: endTime.toISOString(),
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
