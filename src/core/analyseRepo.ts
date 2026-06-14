/**
 * Analyse a full repository.
 * Discovers all *.ts, *.tsx, *.cs files, runs analyzers, persists results.
 */

import { resolve, relative } from 'node:path';
import { globby } from 'globby';
import { openDb } from '../db/connection.js';
import { findRepoById, findRepoByPath, updateRepoStatus, upsertFileIssues, upsertFileDependencies, countIssuesByType, countDependencies, recordAnalysisRun } from '../db/queries.js';
import { runTypeScriptAnalyzer } from '../analyzers/typescript.js';
import { runTsDependencyGraph } from '../analyzers/dependency-graph-ts.js';
import { findCsprojFiles, runCsharpAnalyzer } from '../analyzers/csharp.js';
import { runCsDependencyGraph } from '../analyzers/dependency-graph-cs.js';
import type { AnalyseRepoOutput, RepoRecord } from '../types.js';

export async function analyseRepo(
  repoIdOrPath: number | string,
  _opts?: { force?: boolean },
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

    // TypeScript/TSX analysis
    let tsIssuesCount = 0;
    if (tsFiles.length > 0) {
      const tsPaths = tsFiles.map((f) => resolve(repo.path, f));
      const tsIssuesMap = await runTypeScriptAnalyzer(tsPaths, repo.path);

      // Upsert TS issues (normalize keys from absolute to repo-relative)
      for (const [absPath, issues] of tsIssuesMap) {
        const relPath = relative(repo.path, absPath);
        upsertFileIssues(db, repo.id, relPath, issues);
        tsIssuesCount += issues.length;
      }

      // TS dependency graph
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
          if (possibleAbs.startsWith(repo.path)) {
            sourceRel = relative(repo.path, possibleAbs);
          }
        }

        let importedRel = edge.importedFile;
        if (importedRel) {
          if (importedRel.startsWith('/')) {
            importedRel = relative(repo.path, importedRel);
          } else {
            const possibleAbs = resolve(importedRel);
            if (possibleAbs.startsWith(repo.path)) {
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

    // C# analysis
    let csIssuesCount = 0;
    if (csFiles.length > 0) {
      const csprojPaths = await findCsprojFiles(repo.path);
      if (csprojPaths.length > 0) {
        const { issuesByFile, errors: csErrors } = await runCsharpAnalyzer(csprojPaths, repo.path);

        // Upsert C# issues (normalize keys if needed)
        for (const [filePath, issues] of issuesByFile) {
          // Normalize file path to repo-relative
          const relPath = filePath.startsWith(repo.path)
            ? relative(repo.path, filePath)
            : filePath.startsWith('/')
              ? filePath.slice(1)
              : filePath;

          upsertFileIssues(db, repo.id, relPath, issues);
          csIssuesCount += issues.length;
        }

        errors.push(...csErrors);
      } else if (csFiles.length > 0) {
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
