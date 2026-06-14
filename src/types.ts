/**
 * Shared TypeScript types/interfaces for issues, dependencies, and MCP/CLI
 * tool I/O shapes. Canonical source: PRD.md §6.3 (schema) and §6.4 (API contracts).
 */

export type IssueType = 'BUG' | 'VULNERABILITY' | 'CODE_SMELL' | 'SECURITY_HOTSPOT';

export type IssueSeverity = 'INFO' | 'MINOR' | 'MAJOR' | 'CRITICAL' | 'BLOCKER';

export type IssueStatus = 'OPEN' | 'RESOLVED';

export type Language = 'typescript' | 'csharp';

export type FileLanguage = Language | 'unknown';

export type RepoStatus = 'pending' | 'in_progress' | 'success' | 'failed';

export type AnalysisRunType = 'full_repo' | 'single_file';

/** A single Sonar-classified static analysis issue for one file. */
export interface Issue {
  ruleId: string;
  ruleName?: string;
  type: IssueType;
  severity: IssueSeverity;
  line?: number;
  column?: number;
  message?: string;
  status?: IssueStatus;
}

/** A dependency edge: `sourceFile` imports/uses `importedModule`. */
export interface DependencyEdge {
  sourceFile: string;
  importedModule: string;
  importedFile?: string;
  resolved: boolean;
  language: Language;
}

/** A row of the analysis_repo table. */
export interface RepoRecord {
  id: number;
  path: string;
  name: string | null;
  registeredAt: string;
  lastAnalyzedAt: string | null;
  status: RepoStatus;
}

/** An entry in the global registry (~/.mcp-sonar-analysis/registry.json). */
export interface RegistryEntry {
  repoId: number;
  path: string;
  name: string | null;
  dbPath: string;
  registeredAt: string;
}

/** The global registry file structure. */
export interface RegistryFile {
  repos: RegistryEntry[];
}

// ---------------------------------------------------------------------------
// MCP tool / CLI I/O contracts (PRD.md §6.4)
// ---------------------------------------------------------------------------

export interface RegisterRepoInput {
  path: string;
  name?: string;
}

export interface RegisterRepoOutput {
  repoId: number;
  path: string;
  registeredAt: string;
  alreadyRegistered: boolean;
  status: RepoStatus;
}

export interface AnalyseRepoInput {
  repoId?: number;
  path?: string;
  force?: boolean;
}

export interface AnalyseRepoOutput {
  repoId: number;
  filesAnalyzed: number;
  issuesByType: {
    BUG: number;
    VULNERABILITY: number;
    CODE_SMELL: number;
    SECURITY_HOTSPOT: number;
  };
  dependenciesFound: number;
  durationMs: number;
  errors: string[];
}

export interface GetFileAnalysisInput {
  repoId?: number;
  path?: string;
  filePath: string;
  /** S2: optional filtering */
  type?: IssueType;
  severity?: IssueSeverity;
}

export interface DependsOnEntry {
  module: string;
  resolvedFile?: string;
}

export interface GetFileAnalysisOutput {
  filePath: string;
  language: FileLanguage;
  analyzed: boolean;
  lastAnalyzedAt?: string;
  issues: Issue[];
  dependsOn: DependsOnEntry[];
  dependedOnBy: string[];
}

export type AnalyseFileInput = GetFileAnalysisInput;

export interface AnalyseFileOutput extends GetFileAnalysisOutput {
  durationMs: number;
  analyzedAt: string;
}
