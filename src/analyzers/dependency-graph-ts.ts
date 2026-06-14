/**
 * TypeScript/TSX dependency graph extraction using dependency-cruiser.
 * Analyzes import/require relationships and maps them to DependencyEdge records.
 */

import { cruise } from 'dependency-cruiser';
import type { DependencyEdge } from '../types.js';

interface CruiserModule {
  source: string;
  dependencies: CruiserDependency[];
}

interface CruiserDependency {
  module: string;
  resolved?: string;
  dependencyTypes: string[];
  coreModule: boolean;
  couldNotResolve: boolean;
}

interface CruiserOutput {
  modules: CruiserModule[];
  summary: {
    violations: any[];
    error: number;
    warn: number;
  };
}

/**
 * Run dependency-cruiser on the given file paths and return dependency edges.
 */
export async function runTsDependencyGraph(
  filePaths: string[],
  _repoRoot: string = process.cwd(),
): Promise<DependencyEdge[]> {
  const edges: DependencyEdge[] = [];

  try {
    // Cruise the files with a minimal config
    const cruiseResult = await cruise(filePaths, {
      doNotFollow: {
        path: 'node_modules',
      },
      outputType: 'json',
    });

    // Parse the JSON output (cruiseResult.output is the JSON string)
    let outputData: string;
    if (typeof cruiseResult === 'string') {
      outputData = cruiseResult;
    } else if (cruiseResult && typeof cruiseResult === 'object' && 'output' in cruiseResult) {
      outputData = cruiseResult.output as string;
    } else {
      outputData = JSON.stringify(cruiseResult);
    }

    const json = JSON.parse(outputData) as CruiserOutput;

    // Process each module and its dependencies
    for (const module of json.modules) {
      const sourceFile = module.source;

      for (const dep of module.dependencies) {
        // Determine if this is a resolved internal dependency
        // Internal deps have `resolved` set and don't have 'npm' or 'core' in dependencyTypes
        const isInternal =
          !!dep.resolved &&
          !dep.coreModule &&
          !dep.dependencyTypes.includes('npm') &&
          !dep.dependencyTypes.includes('core');

        const edge: DependencyEdge = {
          sourceFile,
          importedModule: dep.module,
          importedFile: isInternal ? dep.resolved : undefined,
          resolved: isInternal,
          language: 'typescript',
        };

        edges.push(edge);
      }
    }
  } catch (error) {
    console.error(`Error running TS dependency graph:`, error);
  }

  return edges;
}
