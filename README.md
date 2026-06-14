# MCP Sonar Analysis

A local, server-free Model Context Protocol (MCP) server and CLI that brings
Sonar-grade static analysis (BUG, VULNERABILITY, CODE_SMELL, and
SECURITY_HOTSPOT detection) to TypeScript/TSX and C# repositories — no
SonarQube server, no Docker, no external services. Everything runs on your
machine via `eslint-plugin-sonarjs` (TS/TSX) and `SonarAnalyzer.CSharp` (C#),
with results cached in a per-repo SQLite database. Licensed under MIT.

## Features

- **Multi-language analysis**: TypeScript/JavaScript (via ESLint with SonarAnalyzer rules) and C# (via Roslyn)
- **Repository registration**: Register projects for persistent analysis across sessions
- **File-level analysis**: Get detailed issue reports, dependencies, and metrics per file
- **Dependency graph**: Visualize import/using relationships between modules
- **SonarQube rule compatibility**: Detect BUGs, VULNERABILITIES, CODE_SMELL, and SECURITY_HOTSPOT issues
- **MCP integration**: Use as an MCP server in Claude Code for seamless analysis workflows
- **CLI support**: Command-line interface for automation and scripting

## Installation

```bash
# Clone and install
npm install
npm run build

# Install globally for CLI access
npm link
# OR
npm install -g .

# Verify installation
mcp-sonar-analysis-cli --version
```

## MCP Server Registration

Add this to your Claude Code MCP configuration (`.mcp.json` or via `claude mcp add`):

```json
{
  "mcpServers": {
    "mcp-sonar-analysis": {
      "command": "mcp-sonar-analysis-cli",
      "args": ["serve"]
    }
  }
}
```

Or specify the full path:

```json
{
  "mcpServers": {
    "mcp-sonar-analysis": {
      "command": "node",
      "args": ["/path/to/dist/cli.js", "serve"]
    }
  }
}
```

Once registered, the MCP server exposes 4 tools: `register_repo`, `analyse_repo`, `get_file_analysis`, and `analyse_file`.

## CLI Usage

### Register a repository

```bash
mcp-sonar-analysis-cli register-repo /path/to/repo [--name my-repo]
```

**Output:**
```json
{
  "repoId": 1,
  "path": "/path/to/repo",
  "registeredAt": "2025-06-14T10:00:00.000Z",
  "alreadyRegistered": false,
  "status": "pending"
}
```

### Analyze a repository

```bash
# By path
mcp-sonar-analysis-cli analyse-repo /path/to/repo [--force]

# By numeric ID
mcp-sonar-analysis-cli analyse-repo 1
```

**Output:**
```json
{
  "repoId": 1,
  "filesAnalyzed": 15,
  "issuesByType": {
    "BUG": 3,
    "VULNERABILITY": 1,
    "CODE_SMELL": 8,
    "SECURITY_HOTSPOT": 0
  },
  "dependenciesFound": 42,
  "durationMs": 1250,
  "errors": []
}
```

### Get file analysis

```bash
mcp-sonar-analysis-cli get-file-analysis /path/to/repo src/main.ts [--type BUG] [--severity CRITICAL]
```

**Output:**
```json
{
  "filePath": "src/main.ts",
  "language": "typescript",
  "analyzed": true,
  "lastAnalyzedAt": "2025-06-14T10:05:00.000Z",
  "issues": [
    {
      "ruleId": "S1854",
      "ruleName": "Dead store",
      "type": "CODE_SMELL",
      "severity": "MINOR",
      "line": 42,
      "column": 5,
      "message": "Variable is assigned but never used.",
      "status": "OPEN"
    }
  ],
  "dependsOn": [
    {
      "module": "./utils",
      "resolvedFile": "src/utils.ts"
    }
  ],
  "dependedOnBy": ["src/app.ts"]
}
```

### Analyze a single file

```bash
mcp-sonar-analysis-cli analyse-file /path/to/repo src/main.ts [--type BUG] [--severity CRITICAL]
```

**Output:** Same as `get-file-analysis` plus timing:
```json
{
  "filePath": "src/main.ts",
  "language": "typescript",
  "analyzed": true,
  "issues": [...],
  "dependsOn": [...],
  "dependedOnBy": [...],
  "durationMs": 150,
  "analyzedAt": "2025-06-14T10:06:00.000Z"
}
```

### Start the MCP server

```bash
mcp-sonar-analysis-cli serve
```

The server listens on stdin/stdout using the MCP stdio transport and responds to JSON-RPC 2.0 requests from Claude Code.

## Claude Code Hooks Integration

The project includes example hook scripts in `.claude/hooks/` that automate analysis:

- **`session-start.sh`**: Registers the repo and starts full analysis on session start/resume
- **`pre-tool-use.sh`**: Provides file analysis context before you edit (triggered on Edit/Read)
- **`post-tool-use.sh`**: Re-analyzes a file after edits to detect new issues (triggered on Edit/Write)

### Hook Configuration

Hooks are configured in `.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume",
        "hooks": [
          {
            "type": "command",
            "command": "bash \"${CLAUDE_PROJECT_DIR}/.claude/hooks/session-start.sh\"",
            "timeout": 10
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Edit|Read",
        "hooks": [
          {
            "type": "command",
            "command": "bash \"${CLAUDE_PROJECT_DIR}/.claude/hooks/pre-tool-use.sh\"",
            "timeout": 5
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "bash \"${CLAUDE_PROJECT_DIR}/.claude/hooks/post-tool-use.sh\"",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

Note: hook `timeout` values are in **seconds** (not milliseconds), and each
event maps to an array of matcher groups, each with an array of `command`
hooks — this matches the schema Claude Code actually reads from
`.claude/settings.json`.

Each hook receives JSON on stdin with the following structure:

```json
{
  "session_id": "...",
  "transcript_path": "...",
  "cwd": "/path/to/project",
  "hook_event_name": "SessionStart|PreToolUse|PostToolUse",
  "tool_name": "Edit|Write|Read|...",
  "tool_input": { "file_path": "/abs/path/to/file.ts", ... },
  "tool_response": { "stdout": "...", "stderr": "...", "exit_code": 0 }
}
```

**To use these hooks:**

1. Copy `.claude/hooks/` to your Claude Code project directory
2. Update `.claude/settings.json` with the hook configuration above
3. Restart Claude Code or run `claude code sync` to activate hooks

The hooks output additional context (as `additionalContext` in the hook response) that Claude automatically surfaces in your analysis workflow.

## Project Structure

```
.
├── src/
│   ├── cli.ts                        # CLI entry point
│   ├── mcp/
│   │   └── server.ts                 # MCP server (stdio transport)
│   ├── core/
│   │   ├── register.ts               # Register repo
│   │   ├── analyseRepo.ts            # Full repo analysis
│   │   ├── getFileAnalysis.ts        # File analysis (no re-run)
│   │   └── analyseFile.ts            # File analysis (with re-run)
│   ├── analyzers/
│   │   ├── typescript.ts             # TypeScript/ESLint analyzer
│   │   ├── csharp.ts                 # C# Roslyn analyzer
│   │   ├── dependency-graph-ts.ts    # TS import graph
│   │   └── dependency-graph-cs.ts    # C# using directive graph
│   ├── db/
│   │   ├── connection.ts             # SQLite connection
│   │   └── queries.ts                # Database operations
│   └── types.ts                      # Shared TypeScript types
├── test/
│   ├── cli.test.ts                   # End-to-end CLI tests
│   ├── core.test.ts                  # Core logic tests
│   └── fixtures/ts-sample/           # Test fixture
├── .claude/
│   ├── hooks/                        # Example Claude Code hooks
│   │   ├── session-start.sh
│   │   ├── pre-tool-use.sh
│   │   └── post-tool-use.sh
│   └── settings.json                 # Hook configuration
├── dist/                             # Compiled JavaScript (generated)
├── package.json
└── README.md
```

## Architecture Highlights

- **Short-lived databases**: Each operation opens a repo-specific SQLite DB, performs work, and closes it immediately (per PRD §6.7).
- **Numeric repoId support**: Register repos and reference them by ID; the CLI auto-parses numeric arguments as IDs vs. paths.
- **Error propagation**: All errors return JSON with `{ error: "message" }` shape for consistency.
- **MCP contract**: Tools use Zod schemas for validation; responses match SonarQube/MCP conventions.
- **Dependency analysis**: Includes both TypeScript (ESLint dependency-cruiser) and C# (regex-based using directive scanning) dependency graphs.

## Future Work

See Phase 6 notes for planned enhancements.

## License

MIT
