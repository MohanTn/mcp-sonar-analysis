# Sonar Code Quality Analysis

This project uses `mcp-sonar-analysis` — an MCP server providing Sonar-grade static analysis for TypeScript/TSX and C# code.

## Available MCP Tools

The `sonar-analysis` MCP server exposes these tools:

| Tool | Purpose |
|------|---------|
| `register_repo` | Register this repo for analysis (done automatically) |
| `analyse_repo` | Full-repo scan (run once on first use) |
| `get_file_analysis` | Get persisted analysis results for a file |
| `analyse_file` | Re-analyze a single file on demand |

## Workflow Instructions

**Before editing a file**, call `get_file_analysis` to check for existing bugs, vulnerabilities, code smells, and security hotspots. This ensures you understand the current code quality state before making changes.

**After editing a file**, call `analyse_file` to re-analyze it and verify no new issues were introduced. The results will appear in subsequent `get_file_analysis` calls.

**For TypeScript files** — analysis uses ESLint with `eslint-plugin-sonarjs`.
**For C# files** — analysis uses `dotnet build` with `SonarAnalyzer.CSharp`.
