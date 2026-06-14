/**
 * Analyse a full repository.
 * Discovers all *.ts, *.tsx, *.cs files, runs analyzers, persists results.
 */

import { resolve, relative } from 'node:path';
import { stat } from 'node:fs/promises';
import { globby } from 'globby';
import { openDb } from '../db/connection.js';
import { findRepoById, findRepoByPath, updateRepoStatus, upsertFileIssues, upsertFileDependencies, countIssuesByType, countDependencies, recordAnalysisRun, getFileMtime, setFileMtime } from '../db/queries.js';
import { runTypeScriptAnalyzer } from '../analyzers/typescript.js';
import { runTsDependencyGraph } from '../analyzers/dependency-graph-ts.js';
import { findCsprojFiles, runCsharpAnalyzer } from '../analyzers/csharp.js';
import { runCsDependencyGraph } from '../analyzers/dependency-graph-cs.js';
import { isPathInside } from '../util/paths.js';
import type { AnalyseRepoOutput, RepoRecord } from '../types.js';

export async function analyseRepo(
  repoIdOrPath: number | string,
  opts?: { force?: boolean },
): Promise<AnalyseRepoOutput> {
  const startTime = new Date();

  // Resolve repo: try to open DB and find the repo record
  // If repoId is given, assume it's in the current working directory's repo
  // If path is given, use that repo's DB directly
  const dbPath = typeof repoIdOrPath === 'string' ? resolve(repoIdOrPath) : process.cwd();
  let db = openDb(dbPath);
  let repo: RepoRecord;

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
  } catch (error) {
    db.close();
    throw error;
  }

  try {
    // Update status to in_progress
    updateRepoStatus(db, repo.id, 'in_progress');

    // Discover files: .ts, .tsx, .cs with .gitignore respect and hardcoded excludes
    const allFiles = await globby(
      ['**/*.ts', '**/*.tsx', '**/*.cs'],
      {
        cwd: repo.path,
        gitignore: true,
        ignore: ['node_modules', 'bin', 'obj', 'dist', 'build', '.git', '.mcp-sonar-analysis'],
      },
    );

    // Split by language
    const tsFiles = allFiles.filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));
    const csFiles = allFiles.filter((f) => f.endsWith('.cs'));

    const errors: string[] = [];

    // S1: incremental re-analysis. Compare each file's current mtime against
    // the stored mtime; files whose mtime is unchanged since the last
    // analysis are skipped for issue analysis (the expensive ESLint /
    // dotnet-build work). `--force` bypasses this and re-analyzes everything.
    // Dependency-graph analysis still runs over the full file set below,
    // since it is comparatively cheap and graph-wide by nature; unchanged
    // files retain their previously stored issues untouched (no
    // delete-then-insert for them).
    async function partitionByMtime(files: string[]): Promise<{ changed: string[]; unchanged: string[] }> {
      if (opts?.force) {
        return { changed: files, unchanged: [] };
      }
      const changed: string[] = [];
      const unchanged: string[] = [];
      for (const relPath of files) {
        const absPath = resolve(repo.path, relPath);
        let mtimeMs: number;
        try {
          mtimeMs = (await stat(absPath)).mtimeMs;
        } catch {
          // File disappeared between globby and stat; treat as changed so
          // downstream analyzers handle the missing-file case.
          changed.push(relPath);
          continue;
        }
        const stored = getFileMtime(db, repo.id, relPath);
        if (stored !== undefined && stored === mtimeMs) {
          unchanged.push(relPath);
        } else {
          changed.push(relPath);
        }
      }
      return { changed, unchanged };
    }

    async function recordMtimes(files: string[]): Promise<void> {
      for (const relPath of files) {
        try {
          const mtimeMs = (await stat(resolve(repo.path, relPath))).mtimeMs;
          setFileMtime(db, repo.id, relPath, mtimeMs);
        } catch {
          // File disappeared; nothing to record.
        }
      }
    }

    const { changed: tsFilesChanged } = await partitionByMtime(tsFiles);
    const { changed: csFilesChanged } = await partitionByMtime(csFiles);

    // TypeScript/TSX analysis (only re-run on changed files; S1)
    let tsIssuesCount = 0;
    if (tsFilesChanged.length > 0) {
      const tsPaths = tsFilesChanged.map((f) => resolve(repo.path, f));
      const tsIssuesMap = await runTypeScriptAnalyzer(tsPaths, repo.path);

      // Upsert TS issues (normalize keys from absolute to repo-relative)
      for (const [absPath, issues] of tsIssuesMap) {
        const relPath = relative(repo.path, absPath);
        upsertFileIssues(db, repo.id, relPath, issues);
        tsIssuesCount += issues.length;
      }

      await recordMtimes(tsFilesChanged);
    }

    // TS dependency graph: runs over the full TS file set (cheap, graph-wide).
    if (tsFiles.length > 0) {
      const tsPaths = tsFiles.map((f) => resolve(repo.path, f));
      const tsEdges = await runTsDependencyGraph(tsPaths, repo.path);

      // Group edges by sourceFile and upsert (normalize paths to repo-relative)
      // dependency-cruiser returns paths relative to process.cwd(), we need repo-relative
      const edgesBySource = new Map<string, typeof tsEdges>();
      for (const edge of tsEdges) {
        // Normalize sourceFile: try to make it repo-relative
        // If it's absolute, relativize it; if it's relative (cwd-based), check if we need to adjust
        let sourceRel = edge.sourceFile;
        if (sourceRel.startsWith('/')) {
          // Absolute path
          sourceRel = relative(repo.path, sourceRel);
        } else {
          // Relative path - likely cwd-relative from dependency-cruiser
          // Try to resolve it relative to repo and then make it repo-relative
          const possibleAbs = resolve(sourceRel);
          if (isPathInside(possibleAbs, repo.path)) {
            sourceRel = relative(repo.path, possibleAbs);
          }
        }

        let importedRel = edge.importedFile;
        if (importedRel) {
          if (importedRel.startsWith('/')) {
            importedRel = relative(repo.path, importedRel);
          } else {
            const possibleAbs = resolve(importedRel);
            if (isPathInside(possibleAbs, repo.path)) {
              importedRel = relative(repo.path, possibleAbs);
            }
          }
        }

        const normalizedEdge = {
          ...edge,
          sourceFile: sourceRel,
          importedFile: importedRel,
        };

        if (!edgesBySource.has(sourceRel)) {
          edgesBySource.set(sourceRel, []);
        }
        edgesBySource.get(sourceRel)!.push(normalizedEdge);
      }

      // Upsert each source file's edges
      for (const [sourceFile, edges] of edgesBySource) {
        upsertFileDependencies(db, repo.id, sourceFile, edges);
      }

      // Also upsert for TS files with zero deps to ensure they're marked as analyzed
      for (const relPath of tsFiles) {
        if (!edgesBySource.has(relPath)) {
          upsertFileDependencies(db, repo.id, relPath, []);
        }
      }
    }

    // C# analysis. `dotnet build` operates at the project level (not
    // per-file), so S1's incremental skip is applied at that granularity:
    // if no .cs file's mtime changed since the last analysis, skip the
    // (expensive) dotnet build + SARIF parse entirely and keep the
    // previously persisted issues as-is.
    let csIssuesCount = 0;
    if (csFiles.length > 0) {
      const csprojPaths = await findCsprojFiles(repo.path);
      if (csprojPaths.length > 0) {
        if (csFilesChanged.length > 0) {
          const { issuesByFile, errors: csErrors } = await runCsharpAnalyzer(csprojPaths, repo.path);

          // Upsert C# issues (normalize keys if needed)
          for (const [filePath, issues] of issuesByFile) {
            // Normalize file path to repo-relative
            const relPath = isPathInside(filePath, repo.path)
              ? relative(repo.path, filePath)
              : filePath.startsWith('/')
                ? filePath.slice(1)
                : filePath;

            upsertFileIssues(db, repo.id, relPath, issues);
            csIssuesCount += issues.length;
          }

          errors.push(...csErrors);
          await recordMtimes(csFilesChanged);
        }
        // else: no .cs file changed since last analysis — skip dotnet build
        // entirely; previously persisted C# issues remain untouched and are
        // reflected in issuesByType below via the DB-wide count.
      } else {
        // C# files found but no .csproj
        errors.push('C# files found but no .csproj files detected — skipping C# analysis');
      }
    }

    // C# dependency graph: this is a regex/syntax-based `using`-directive scan
    // (src/analyzers/dependency-graph-cs.ts) and does NOT require the dotnet
    // SDK, unlike the SonarAnalyzer.CSharp issue analysis above — so it runs
    // unconditionally whenever .cs files are present.
    if (csFiles.length > 0) {
      const csPaths = csFiles.map((f) => resolve(repo.path, f));
      const csEdges = await runCsDependencyGraph(csPaths, repo.path);

      // Group edges by sourceFile and normalize to repo-relative
      const csEdgesBySource = new Map<string, typeof csEdges>();
      for (const edge of csEdges) {
        // edge.sourceFile is absolute (as passed from csPaths)
        const sourceRel = relative(repo.path, edge.sourceFile);
        // edge.importedFile is already repo-relative from the analyzer
        const importedRel = edge.importedFile ?? undefined;

        const normalizedEdge = {
          ...edge,
          sourceFile: sourceRel,
          importedFile: importedRel,
        };

        if (!csEdgesBySource.has(sourceRel)) {
          csEdgesBySource.set(sourceRel, []);
        }
        csEdgesBySource.get(sourceRel)!.push(normalizedEdge);
      }

      // Upsert each C# source file's edges
      for (const [sourceFile, edges] of csEdgesBySource) {
        upsertFileDependencies(db, repo.id, sourceFile, edges);
      }

      // Also upsert for C# files with zero deps
      for (const relPath of csFiles) {
        if (!csEdgesBySource.has(relPath)) {
          upsertFileDependencies(db, repo.id, relPath, []);
        }
      }
    }

    // Compute statistics
    const issuesByType = countIssuesByType(db, repo.id);
    const dependenciesFound = countDependencies(db, repo.id);
    const filesAnalyzed = tsFiles.length + csFiles.length;

    const endTime = new Date();
    const durationMs = endTime.getTime() - startTime.getTime();

    // Update repo status to success
    updateRepoStatus(db, repo.id, 'success', endTime.toISOString());

    // Record analysis run
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
