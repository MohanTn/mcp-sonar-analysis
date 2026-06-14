/**
 * C# dependency graph extraction via using-directive scanning.
 * Scans .cs files for `using Namespace.Path;` directives and attempts to resolve them
 * to in-repo files via a best-effort namespace-to-file mapping.
 *
 * This is the ~85-90% accurate approach per PRD.md §10 (Roslyn semantic analysis deferred).
 * Uses regex to extract namespace and using declarations, then matches using directives
 * against known namespace declarations in the repo.
 */

import { readFileSync } from 'node:fs';
import { globby } from 'globby';
import type { DependencyEdge } from '../types.js';

/**
 * Regex to extract namespace declarations from C# code.
 * Handles both old-style (namespace Foo { }) and C# 10+ file-scoped (namespace Foo;) syntax.
 * Captures the namespace name(s).
 */
const NAMESPACE_PATTERN = /^\s*namespace\s+([\w.]+)\s*[{;]/m;

/**
 * Regex to extract using directives from C# code.
 * Matches `using Namespace.Path;` but excludes:
 * - `using static Namespace.Path;`
 * - `using (Type var = ...) { }` (statement-level, not import-style)
 *
 * Captures the imported namespace.
 */
const USING_PATTERN = /^\s*using\s+(?!static\b)([\w.]+)\s*;/gm;

/**
 * Find all .cs files in the given repo and build a map of namespace -> file.
 */
async function buildNamespaceMap(repoRoot: string): Promise<Map<string, string>> {
  const namespaceMap = new Map<string, string>();

  try {
    const csFiles = await globby('**/*.cs', {
      cwd: repoRoot,
      ignore: ['**/bin/**', '**/obj/**', '**/node_modules/**', '**/.mcp-sonar-analysis/**'],
      absolute: false,
    });

    for (const csFile of csFiles) {
      const fullPath = `${repoRoot}/${csFile}`;
      try {
        const content = readFileSync(fullPath, 'utf-8');

        // Extract namespace declaration
        const nsMatch = content.match(NAMESPACE_PATTERN);
        if (nsMatch) {
          const namespace = nsMatch[1];
          // Store the namespace -> file mapping (relative path from repoRoot)
          namespaceMap.set(namespace, csFile);
        }
      } catch (error) {
        // Log but continue on file read errors
        console.error(`Error reading ${fullPath}:`, error);
      }
    }
  } catch (error) {
    console.error(`Error discovering .cs files:`, error);
  }

  return namespaceMap;
}

/**
 * Extract using directives from a C# file and attempt to resolve them.
 */
function extractUsingDirectives(fileContent: string): string[] {
  const usings: string[] = [];

  // Reset the global pattern's lastIndex for fresh execution
  USING_PATTERN.lastIndex = 0;

  let match = USING_PATTERN.exec(fileContent);
  while (match !== null) {
    usings.push(match[1]);
    match = USING_PATTERN.exec(fileContent);
  }

  return usings;
}

/**
 * Attempt to resolve a using namespace to a file.
 * Uses exact match first, then prefix match as a best-effort fallback.
 *
 * @param usingNamespace The namespace being imported (e.g., "CsSample.Models")
 * @param namespaceMap Mapping of known namespaces to files
 * @returns The file path if found, undefined if not resolved
 */
function resolveUsingToFile(usingNamespace: string, namespaceMap: Map<string, string>): string | undefined {
  // Exact match: the using namespace matches a declared namespace
  if (namespaceMap.has(usingNamespace)) {
    return namespaceMap.get(usingNamespace);
  }

  // Prefix match: the using is a parent namespace of a declared namespace
  // E.g., using CsSample could resolve to a file declaring CsSample.Models
  for (const [declaredNamespace, file] of namespaceMap) {
    if (declaredNamespace.startsWith(usingNamespace + '.')) {
      return file;
    }
  }

  return undefined;
}

/**
 * Run C# dependency graph extraction on the given .cs files.
 * Returns DependencyEdge[] with resolved and unresolved edges.
 */
export async function runCsDependencyGraph(csFilePaths: string[], repoRoot: string): Promise<DependencyEdge[]> {
  const edges: DependencyEdge[] = [];

  try {
    // Build a namespace -> file mapping for the entire repo
    const namespaceMap = await buildNamespaceMap(repoRoot);

    // Process each input file
    for (const csFilePath of csFilePaths) {
      try {
        const content = readFileSync(csFilePath, 'utf-8');

        // Extract using directives from this file
        const usings = extractUsingDirectives(content);

        // For each using, try to resolve it
        for (const usingNamespace of usings) {
          const importedFile = resolveUsingToFile(usingNamespace, namespaceMap);
          const resolved = !!importedFile;

          const edge: DependencyEdge = {
            sourceFile: csFilePath,
            importedModule: usingNamespace,
            importedFile,
            resolved,
            language: 'csharp',
          };

          edges.push(edge);
        }
      } catch (error) {
        console.error(`Error processing ${csFilePath}:`, error);
      }
    }
  } catch (error) {
    console.error(`Error running C# dependency graph:`, error);
  }

  return edges;
}
