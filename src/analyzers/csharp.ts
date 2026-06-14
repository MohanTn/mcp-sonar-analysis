/**
 * C# analyzer using dotnet build + SARIF parsing with SonarAnalyzer.CSharp
 * Detects .csproj files, runs dotnet build with SARIF output, and parses results.
 * Gracefully degrades (S3) if dotnet SDK is not available.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, unlinkSync } from 'node:fs';
import { tmpdir, cpus } from 'node:os';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { globby } from 'globby';
import type { Issue } from '../types.js';

const execFileAsync = promisify(execFile);

/**
 * Check if dotnet SDK is available on PATH.
 * Returns false (never throws) if dotnet is not available.
 */
export async function isDotnetAvailable(): Promise<boolean> {
  try {
    await execFileAsync('dotnet', ['--version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Find all .csproj files under the given directory.
 * Excludes bin/, obj/, node_modules/ directories.
 */
export async function findCsprojFiles(repoRoot: string): Promise<string[]> {
  try {
    const files = await globby('**/*.csproj', {
      cwd: repoRoot,
      ignore: ['**/bin/**', '**/obj/**', '**/node_modules/**', '**/.mcp-sonar-analysis/**'],
      absolute: false,
    });
    return files.map((f) => resolve(repoRoot, f));
  } catch (error) {
    console.error(`Error finding .csproj files:`, error);
    return [];
  }
}

/**
 * SARIF result object structure (minimal schema for parsing).
 * See: https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/sarif-v2.1.0-os.html
 */
interface SarifResult {
  ruleId?: string;
  level?: 'none' | 'note' | 'warning' | 'error';
  message?: { text?: string };
  locations?: Array<{
    physicalLocation?: {
      artifactLocation?: { uri?: string };
      region?: {
        startLine?: number;
        startColumn?: number;
        endLine?: number;
        endColumn?: number;
      };
    };
  }>;
  properties?: Record<string, any>;
}

interface SarifRule {
  id?: string;
  properties?: Record<string, any>;
}

interface SarifDriver {
  name?: string;
  rules?: SarifRule[];
}

interface SarifRun {
  tool?: { driver?: SarifDriver };
  results?: SarifResult[];
}

interface SarifDocument {
  runs?: SarifRun[];
}

/**
 * Parse a SARIF JSON document into Issue[] grouped by file.
 * Maps SARIF properties to Sonar types and severity levels.
 * Defensive parsing: does not throw on missing fields, logs warnings instead.
 */
export function parseSarif(sarifJson: SarifDocument, _repoRoot: string): Map<string, Issue[]> {
  const issuesByFile = new Map<string, Issue[]>();

  if (!sarifJson.runs || sarifJson.runs.length === 0) {
    return issuesByFile;
  }

  const run = sarifJson.runs[0];
  if (!run.results || run.results.length === 0) {
    return issuesByFile;
  }

  // Build a rule lookup table: ruleId -> rule metadata
  const rulesById = new Map<string, SarifRule>();
  if (run.tool?.driver?.rules) {
    for (const rule of run.tool.driver.rules) {
      if (rule.id) {
        rulesById.set(rule.id, rule);
      }
    }
  }

  /**
   * Map SARIF level to Sonar severity.
   * SARIF levels: 'none', 'note', 'warning', 'error'
   * Sonar severities: 'INFO', 'MINOR', 'MAJOR', 'CRITICAL', 'BLOCKER'
   */
  function mapLevel(level?: string): 'INFO' | 'MINOR' | 'MAJOR' | 'CRITICAL' | 'BLOCKER' {
    switch (level) {
      case 'error':
        return 'MAJOR';
      case 'warning':
        return 'MINOR';
      case 'note':
        return 'INFO';
      case 'none':
      default:
        return 'MINOR';
    }
  }

  /**
   * Map tags or sonarType property to Sonar issue type.
   * Looks for properties.tags[] array or properties.sonarType string.
   * Falls back to CODE_SMELL if not found.
   */
  function mapType(ruleMetadata?: SarifRule): 'BUG' | 'VULNERABILITY' | 'CODE_SMELL' | 'SECURITY_HOTSPOT' {
    if (!ruleMetadata?.properties) {
      return 'CODE_SMELL';
    }

    // Try explicit sonarType property first
    const sonarType = ruleMetadata.properties.sonarType;
    if (sonarType === 'BUG' || sonarType === 'VULNERABILITY' || sonarType === 'CODE_SMELL' || sonarType === 'SECURITY_HOTSPOT') {
      return sonarType;
    }

    // Try tags array
    const tags = ruleMetadata.properties.tags;
    if (Array.isArray(tags)) {
      const tagsLower = tags.map((t: string) => (typeof t === 'string' ? t.toLowerCase() : ''));
      if (tagsLower.includes('vulnerability')) {
        return 'VULNERABILITY';
      }
      if (tagsLower.includes('security-hotspot')) {
        return 'SECURITY_HOTSPOT';
      }
      if (tagsLower.includes('bug')) {
        return 'BUG';
      }
      if (tagsLower.includes('code-smell')) {
        return 'CODE_SMELL';
      }
    }

    return 'CODE_SMELL';
  }

  // Parse each result
  for (const result of run.results) {
    const ruleId = result.ruleId || 'unknown';
    const ruleMetadata = rulesById.get(ruleId);

    // Get file path from the first location
    if (!result.locations || result.locations.length === 0) {
      continue;
    }

    const location = result.locations[0];
    const artifactUri = location.physicalLocation?.artifactLocation?.uri;
    if (!artifactUri) {
      continue;
    }

    // Resolve artifact URI to repo-relative path
    // For now, treat it as already repo-relative (from dotnet build)
    const filePath = artifactUri.startsWith('/') ? artifactUri.slice(1) : artifactUri;

    const region = location.physicalLocation?.region;
    const line = region?.startLine;
    const column = region?.startColumn;

    const issue: Issue = {
      ruleId,
      type: mapType(ruleMetadata),
      severity: mapLevel(result.level),
      line,
      column,
      message: result.message?.text,
    };

    // Group by file
    if (!issuesByFile.has(filePath)) {
      issuesByFile.set(filePath, []);
    }
    issuesByFile.get(filePath)!.push(issue);
  }

  return issuesByFile;
}

/**
 * Simple semaphore for bounded concurrency.
 * Allows up to `maxConcurrent` tasks to run simultaneously.
 */
class Semaphore {
  private permits: number;
  private waitQueue: Array<() => void> = [];

  constructor(maxConcurrent: number) {
    this.permits = maxConcurrent;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }

    return new Promise((resolve) => {
      this.waitQueue.push(() => {
        this.permits--;
        resolve();
      });
    });
  }

  release(): void {
    this.permits++;
    const waiter = this.waitQueue.shift();
    if (waiter) {
      waiter();
    }
  }
}

/**
 * Run dotnet build on a single .csproj file and parse SARIF output.
 * Returns issues and any build errors.
 */
async function buildProjectAndParseSarif(
  csprojPath: string,
  repoRoot: string,
): Promise<{ issuesByFile: Map<string, Issue[]>; errors: string[] }> {
  const errors: string[] = [];
  const issuesByFile = new Map<string, Issue[]>();

  try {
    // Create a temporary SARIF file path
    const sarifFileName = `sonar-${randomUUID()}.sarif`;
    const sarifPath = resolve(tmpdir(), sarifFileName);

    // Run dotnet build with SARIF output
    try {
      await execFileAsync('dotnet', ['build', csprojPath, `/p:ErrorLog=${sarifPath}`, '/p:RunAnalyzersDuringBuild=true'], {
        timeout: 120000, // 120s timeout per project
        cwd: repoRoot,
      });
    } catch (buildError) {
      // Build may fail due to compilation errors, but SARIF may still be generated
      // Log the error but continue to try parsing SARIF
      if (buildError instanceof Error) {
        errors.push(`dotnet build failed for ${csprojPath}: ${buildError.message}`);
      }
    }

    // Try to read and parse SARIF file
    try {
      const sarifContent = readFileSync(sarifPath, 'utf-8');
      const sarifJson = JSON.parse(sarifContent) as SarifDocument;
      const parsed = parseSarif(sarifJson, repoRoot);

      // Merge parsed issues
      for (const [file, issues] of parsed) {
        if (!issuesByFile.has(file)) {
          issuesByFile.set(file, []);
        }
        issuesByFile.get(file)!.push(...issues);
      }
    } catch (parseError) {
      if (parseError instanceof Error) {
        errors.push(`Failed to parse SARIF for ${csprojPath}: ${parseError.message}`);
      }
    } finally {
      // Clean up temp SARIF file
      try {
        unlinkSync(sarifPath);
      } catch {
        // Ignore cleanup errors
      }
    }
  } catch (error) {
    if (error instanceof Error) {
      errors.push(`Error processing ${csprojPath}: ${error.message}`);
    }
  }

  return { issuesByFile, errors };
}

/**
 * Run C# analyzer on all discovered .csproj files.
 * If dotnet is not available, returns empty results + graceful error message (S3).
 * For each .csproj, runs dotnet build in parallel (bounded concurrency).
 */
export async function runCsharpAnalyzer(
  csprojPaths: string[],
  repoRoot: string,
): Promise<{ issuesByFile: Map<string, Issue[]>; errors: string[] }> {
  const issuesByFile = new Map<string, Issue[]>();
  const allErrors: string[] = [];

  // Check if dotnet is available
  const dotnetAvailable = await isDotnetAvailable();
  if (!dotnetAvailable) {
    allErrors.push('dotnet SDK not found on PATH — skipping C# analysis (S3 graceful degradation)');
    return { issuesByFile, errors: allErrors };
  }

  // If no projects found, return early
  if (csprojPaths.length === 0) {
    return { issuesByFile, errors: allErrors };
  }

  // Build with bounded concurrency
  const maxConcurrent = Math.min(4, Math.max(1, cpus().length));
  const semaphore = new Semaphore(maxConcurrent);

  const tasks = csprojPaths.map(async (csprojPath) => {
    await semaphore.acquire();
    try {
      const { issuesByFile: projectIssues, errors: projectErrors } = await buildProjectAndParseSarif(csprojPath, repoRoot);

      // Merge results
      for (const [file, issues] of projectIssues) {
        if (!issuesByFile.has(file)) {
          issuesByFile.set(file, []);
        }
        issuesByFile.get(file)!.push(...issues);
      }

      allErrors.push(...projectErrors);
    } finally {
      semaphore.release();
    }
  });

  await Promise.all(tasks);

  return { issuesByFile, errors: allErrors };
}

/**
 * Run C# analyzer on the .csproj containing the given file.
 * For a single file analysis, we need to identify its containing project and run the build for that project only.
 *
 * Returns `issuesByFile` (not a flattened array) so callers can pick out the
 * issues belonging to the specific file they're analyzing — a `dotnet build`
 * of a project produces diagnostics for ALL files in that project, and
 * `analyse_file` must only persist issues for the single requested file
 * (per PRD M4: "upserts fresh results... replacing prior rows for that file").
 */
export async function runCsharpAnalyzerForFile(
  csprojPath: string,
  repoRoot: string,
): Promise<{ issuesByFile: Map<string, Issue[]>; errors: string[] }> {
  const dotnetAvailable = await isDotnetAvailable();
  if (!dotnetAvailable) {
    return {
      issuesByFile: new Map(),
      errors: ['dotnet SDK not found on PATH — skipping C# analysis (S3 graceful degradation)'],
    };
  }

  return buildProjectAndParseSarif(csprojPath, repoRoot);
}
