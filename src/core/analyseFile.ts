/**
 * Analyse a single file and refresh its results.
 * Runs appropriate analyzer, upserts issues and dependencies, returns fresh analysis.
 */

import { resolve, relative, dirname } from 'node:path';
import { stat } from 'node:fs/promises';
import { openDb } from '../db/connection.js';
import { findRepoById, findRepoByPath, upsertFileIssues, upsertFileDependencies, recordAnalysisRun, setFileMtime } from '../db/queries.js';
import { runTypeScriptAnalyzer } from '../analyzers/typescript.js';
import { runTsDependencyGraph } from '../analyzers/dependency-graph-ts.js';
import { findCsprojFiles, runCsharpAnalyzerForFile } from '../analyzers/csharp.js';
import { runCsDependencyGraph } from '../analyzers/dependency-graph-cs.js';
import { getFileAnalysis } from './getFileAnalysis.js';
import type { AnalyseFileOutput, FileLanguage, IssueSeverity, IssueType, RepoRecord, Issue, DependencyEdge } from '../types.js';

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
    // Check if csprojDir is an ancestor of fileDir
    if (fileDir.startsWith(csprojDir)) {
      const depth = csprojDir.split('/').length;
      if (depth > closestDepth) {
        closest = csproj;
        closestDepth = depth;
      }
    }
  }

  return closest;
}

export async function analyseFile(
  repoIdOrPath: number | string,
  filePath: string,
  opts?: { type?: IssueType; severity?: IssueSeverity },
): Promise<AnalyseFileOutput> {
  const startTime = new Date();

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

    // At this point, repo is guaranteed to be non-null (assert for TS)
    if (!repo) {
      throw new Error('Failed to resolve repo');
    }
    const repoResolved: RepoRecord = repo;

    // Normalize file path to repo-relative and absolute
    const relFilePath = filePath.startsWith(repoResolved.path)
      ? relative(repoResolved.path, filePath)
      : filePath.startsWith('/')
        ? filePath.slice(1)
        : filePath;

    const absFilePath = resolve(repoResolved.path, relFilePath);

    // Determine language by extension
    const language: FileLanguage = relFilePath.endsWith('.ts') || relFilePath.endsWith('.tsx')
      ? 'typescript'
      : relFilePath.endsWith('.cs')
        ? 'csharp'
        : 'unknown';

    const errors: string[] = [];
    let issues: Issue[] = [];

    // Run appropriate analyzer
    if (language === 'typescript') {
      const tsIssuesMap = await runTypeScriptAnalyzer([absFilePath], repoResolved.path);
      issues = tsIssuesMap.get(absFilePath) ?? [];

      // TS dependency graph for this file
      const tsEdges = await runTsDependencyGraph([absFilePath], repoResolved.path);
      const normalizedEdges: DependencyEdge[] = tsEdges.map((edge) => {
        // Normalize paths similar to analyseRepo
        let sourceRel = edge.sourceFile;
        if (sourceRel.startsWith('/')) {
          sourceRel = relative(repoResolved.path, sourceRel);
        } else {
          const possibleAbs = resolve(sourceRel);
          if (possibleAbs.startsWith(repoResolved.path)) {
            sourceRel = relative(repoResolved.path, possibleAbs);
          }
        }

        let importedRel = edge.importedFile;
        if (importedRel) {
          if (importedRel.startsWith('/')) {
            importedRel = relative(repoResolved.path, importedRel);
          } else {
            const possibleAbs = resolve(importedRel);
            if (possibleAbs.startsWith(repoResolved.path)) {
              importedRel = relative(repoResolved.path, possibleAbs);
            }
          }
        }

        return {
          ...edge,
          sourceFile: sourceRel,
          importedFile: importedRel,
        };
      });

      upsertFileDependencies(db, repoResolved.id, relFilePath, normalizedEdges);
    } else if (language === 'csharp') {
      // Find containing .csproj
      const csproj = await findContainingCsproj(absFilePath, repoResolved.path);
      if (!csproj) {
        errors.push(`No .csproj file found for ${relFilePath}`);
      } else {
        const { issuesByFile, errors: csErrors } = await runCsharpAnalyzerForFile(csproj, repoResolved.path);
        errors.push(...csErrors);

        // A `dotnet build` of the containing project produces diagnostics for
        // ALL files in that project; pick out only the entry for this file.
        // SARIF artifactLocation.uri may be repo-relative, project-relative,
        // or absolute depending on the toolchain, so match defensively by
        // comparing normalized (repo-relative) paths.
        for (const [sarifPath, fileIssues] of issuesByFile) {
          const normalizedSarifPath = sarifPath.startsWith(repoResolved.path)
            ? relative(repoResolved.path, sarifPath)
            : sarifPath.replace(/^\/+/, '');
          if (normalizedSarifPath === relFilePath || sarifPath === absFilePath) {
            issues = fileIssues;
            break;
          }
        }
      }

      // C# dependency graph for this file
      const csEdges = await runCsDependencyGraph([absFilePath], repoResolved.path);
      const normalizedCsEdges: DependencyEdge[] = csEdges.map((edge) => ({
        ...edge,
        sourceFile: relative(repoResolved.path, edge.sourceFile),
        importedFile: edge.importedFile ?? undefined,
      }));

      upsertFileDependencies(db, repoResolved.id, relFilePath, normalizedCsEdges);
    } else {
      errors.push(`Unsupported file type: ${language}`);
    }

    // Upsert issues
    upsertFileIssues(db, repoResolved.id, relFilePath, issues);

    // Record this file's current mtime (S1: keeps analyse_repo's incremental
    // skip in sync with out-of-band single-file analyses, e.g. via hooks).
    try {
      const mtimeMs = (await stat(absFilePath)).mtimeMs;
      setFileMtime(db, repoResolved.id, relFilePath, mtimeMs);
    } catch {
      // File may have been deleted between analysis and this point; ignore.
    }

    const endTime = new Date();
    const durationMs = endTime.getTime() - startTime.getTime();

    // Record analysis run
    recordAnalysisRun(db, {
      repoId: repoResolved.id,
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
    const analysis = await getFileAnalysis(repoResolved.path, relFilePath, opts);

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
