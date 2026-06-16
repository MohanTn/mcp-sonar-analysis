#!/usr/bin/env node

/**
 * CLI for mcp-sonar-analysis.
 * Subcommands: register-repo, unregister-repo, analyse-repo, get-file-analysis, analyse-file, serve, dashboard.
 */

import { resolve } from 'node:path';
import { Command } from 'commander';
import { registerRepo } from './core/register.js';
import { analyseRepo } from './core/analyseRepo.js';
import { getFileAnalysis } from './core/getFileAnalysis.js';
import { analyseFile } from './core/analyseFile.js';
import { startServer } from './mcp/server.js';
import { removeRegistryEntry } from './dashboard/registry.js';

const program = new Command();
program.name('mcp-sonar-analysis-cli').version('1.0.0');

// Utility to parse repoIdOrPath: if it's a number, treat as repoId, else as path
function parseRepoIdOrPath(arg: string): number | string {
  if (/^\d+$/.test(arg)) {
    return Number(arg);
  }
  return arg;
}

// Helper for error output
function outputError(message: string) {
  const output = JSON.stringify({ error: message });
  console.error(output);
  process.exit(1);
}

// register-repo <path> [--name <name>]
program
  .command('register-repo <path>')
  .option('--name <name>', 'Repository name')
  .action(async (path, options) => {
    try {
      const result = await registerRepo(path, options.name);
      console.log(JSON.stringify(result));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outputError(message);
    }
  });

// unregister-repo <path>
program
  .command('unregister-repo <path>')
  .description('Remove a repository from the global registry (does not delete analysis data on disk)')
  .action(async (path) => {
    try {
      const canonicalPath = resolve(path);
      removeRegistryEntry(canonicalPath);
      console.log(JSON.stringify({ success: true, path: canonicalPath }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outputError(message);
    }
  });

// analyse-repo <repoIdOrPath> [--force]
program
  .command('analyse-repo <repoIdOrPath>')
  .option('--force', 'Force re-analysis')
  .action(async (repoIdOrPath, options) => {
    try {
      const parsed = parseRepoIdOrPath(repoIdOrPath);
      const result = await analyseRepo(parsed, { force: options.force });
      console.log(JSON.stringify(result));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outputError(message);
    }
  });

// get-file-analysis <repoIdOrPath> <filePath> [--type <type>] [--severity <severity>]
program
  .command('get-file-analysis <repoIdOrPath> <filePath>')
  .option('--type <type>', 'Filter by issue type (BUG|VULNERABILITY|CODE_SMELL|SECURITY_HOTSPOT)')
  .option('--severity <severity>', 'Filter by severity (INFO|MINOR|MAJOR|CRITICAL|BLOCKER)')
  .action(async (repoIdOrPath, filePath, options) => {
    try {
      const parsed = parseRepoIdOrPath(repoIdOrPath);
      const result = await getFileAnalysis(parsed, filePath, {
        type: options.type,
        severity: options.severity,
      });
      console.log(JSON.stringify(result));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outputError(message);
    }
  });

// analyse-file <repoIdOrPath> <filePath> [--type <type>] [--severity <severity>]
program
  .command('analyse-file <repoIdOrPath> <filePath>')
  .option('--type <type>', 'Filter by issue type (BUG|VULNERABILITY|CODE_SMELL|SECURITY_HOTSPOT)')
  .option('--severity <severity>', 'Filter by severity (INFO|MINOR|MAJOR|CRITICAL|BLOCKER)')
  .action(async (repoIdOrPath, filePath, options) => {
    try {
      const parsed = parseRepoIdOrPath(repoIdOrPath);
      const result = await analyseFile(parsed, filePath, {
        type: options.type,
        severity: options.severity,
      });
      console.log(JSON.stringify(result));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outputError(message);
    }
  });

// serve: start MCP stdio server
program
  .command('serve')
  .description('Start the MCP stdio server')
  .action(async () => {
    try {
      await startServer();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ error: message }));
      process.exit(1);
    }
  });

// dashboard: start local web dashboard
program
  .command('dashboard')
  .description('Start the local web dashboard (http://127.0.0.1, read-only)')
  .option('--port <n>', 'HTTP port', '4319')
  .action(async (options) => {
    try {
      const port = Number(options.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        outputError(`Invalid port: ${options.port}`);
        return;
      }
      const { startDashboardServer } = await import('./dashboard/server.js');
      await startDashboardServer(port);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outputError(message);
    }
  });

program.parse(process.argv);
