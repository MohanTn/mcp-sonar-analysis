/**
 * MCP server using stdio transport.
 * Exposes 4 tools: register_repo, analyse_repo, get_file_analysis, analyse_file.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { registerRepo } from '../core/register.js';
import { analyseRepo } from '../core/analyseRepo.js';
import { getFileAnalysis } from '../core/getFileAnalysis.js';
import { analyseFile } from '../core/analyseFile.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// Schemas for each tool, matching PRD §6.4

const registerRepoSchema = z.object({
  path: z.string().describe('Repository path'),
  name: z.string().describe('Optional repository name').optional(),
});

const analyseRepoSchema = z.object({
  repoId: z.number().describe('Repository ID').optional(),
  path: z.string().describe('Repository path').optional(),
  force: z.boolean().describe('Force re-analysis').optional(),
});

const fileAnalysisSchema = z.object({
  repoId: z.number().describe('Repository ID').optional(),
  path: z.string().describe('Repository path').optional(),
  filePath: z.string().describe('File path within repository'),
  type: z.enum(['BUG', 'VULNERABILITY', 'CODE_SMELL', 'SECURITY_HOTSPOT'])
    .describe('Filter by issue type')
    .optional(),
  severity: z.enum(['INFO', 'MINOR', 'MAJOR', 'CRITICAL', 'BLOCKER'])
    .describe('Filter by issue severity')
    .optional(),
});

export async function createServer() {
  const server = new McpServer({
    name: 'mcp-sonar-analysis',
    version: '1.0.0',
  });

  // register_repo tool
  server.registerTool(
    'register_repo',
    {
      description: 'Register a repository for analysis',
      inputSchema: registerRepoSchema,
    },
    async (args): Promise<CallToolResult> => {
      try {
        const result = await registerRepo(args.path, args.name);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result),
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: message }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // analyse_repo tool
  server.registerTool(
    'analyse_repo',
    {
      description: 'Analyze a repository',
      inputSchema: analyseRepoSchema,
    },
    async (args): Promise<CallToolResult> => {
      try {
        // Require at least one of repoId or path
        if (args.repoId === undefined && args.path === undefined) {
          throw new Error('Either repoId or path must be provided');
        }

        const repoIdOrPath = args.repoId ?? args.path!;
        const result = await analyseRepo(repoIdOrPath, { force: args.force });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result),
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: message }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // get_file_analysis tool
  server.registerTool(
    'get_file_analysis',
    {
      description: 'Get analysis results for a specific file',
      inputSchema: fileAnalysisSchema,
    },
    async (args): Promise<CallToolResult> => {
      try {
        if (args.repoId === undefined && args.path === undefined) {
          throw new Error('Either repoId or path must be provided');
        }

        const repoIdOrPath = args.repoId ?? args.path!;
        const result = await getFileAnalysis(repoIdOrPath, args.filePath, {
          type: args.type,
          severity: args.severity,
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result),
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: message }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // analyse_file tool
  server.registerTool(
    'analyse_file',
    {
      description: 'Analyze a specific file',
      inputSchema: fileAnalysisSchema,
    },
    async (args): Promise<CallToolResult> => {
      try {
        if (args.repoId === undefined && args.path === undefined) {
          throw new Error('Either repoId or path must be provided');
        }

        const repoIdOrPath = args.repoId ?? args.path!;
        const result = await analyseFile(repoIdOrPath, args.filePath, {
          type: args.type,
          severity: args.severity,
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result),
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: message }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  return server;
}

export async function startServer() {
  const server = await createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// If run directly as a script
if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().catch(error => {
    console.error('Failed to start MCP server:', error);
    process.exit(1);
  });
}
