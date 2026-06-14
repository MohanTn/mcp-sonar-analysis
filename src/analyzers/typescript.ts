/**
 * TypeScript/TSX analyzer using ESLint + eslint-plugin-sonarjs
 * Runs the ESLint programmatic API with a flat config to detect SonarJS violations.
 */

import { ESLint } from 'eslint';
import sonarjsPlugin from 'eslint-plugin-sonarjs';
import typescriptEslintParser from '@typescript-eslint/parser';
import type { Issue } from '../types.js';

/**
 * Extract Sonar rule key (S####) from a rule ID.
 * The ESLint rule ID format is 'sonarjs/rule-name', and we need to extract the Sonar key
 * from the rule metadata docs URL or rule key mapping.
 */
function extractSonarRuleKey(ruleId: string, ruleMetadata?: { docs?: { url?: string } }): string {
  // First check if we can extract from the docs URL
  // URL format: https://sonarsource.github.io/rspec/#/rspec/S1234/javascript
  if (ruleMetadata?.docs?.url) {
    const match = ruleMetadata.docs.url.match(/\/rspec\/([SH]\d+)\//);
    if (match) {
      return match[1];
    }
  }

  // Fallback: just return the ruleId as-is (strip plugin prefix if present)
  if (ruleId.startsWith('sonarjs/')) {
    return ruleId.slice(8); // Remove 'sonarjs/' prefix
  }

  return ruleId;
}

/**
 * Map ESLint severity to Sonar severity.
 * ESLint has only 'warning' and 'error'; map to Sonar's 5-level scale.
 * Based on eslint-plugin-sonarjs rule metadata, we can look up specific rules.
 */
function mapToSonarSeverity(
  severity: number | string,
  _ruleId: string,
  _allRules?: Record<string, any>,
): 'INFO' | 'MINOR' | 'MAJOR' | 'CRITICAL' | 'BLOCKER' {
  // For now, use a simple mapping: error -> MAJOR, warning -> MINOR
  // This can be enhanced with a rule-specific lookup table if needed
  let numSeverity: number;
  if (typeof severity === 'string') {
    numSeverity = severity === 'error' ? 2 : 1;
  } else {
    numSeverity = severity;
  }
  return numSeverity >= 2 ? 'MAJOR' : 'MINOR';
}

/**
 * Map ESLint message type to Sonar issue type.
 * The sonarjs plugin's rules have metadata indicating their Sonar type.
 */
function mapToSonarType(
  _ruleId: string,
  ruleMetadata?: { docs?: { url?: string }; type?: string },
): 'BUG' | 'VULNERABILITY' | 'CODE_SMELL' | 'SECURITY_HOTSPOT' {
  // Build a static mapping for known rules based on Sonar classification
  // These are the most common sonarjs rules and their Sonar types
  // Note: The ESLint rule name (e.g., 'no-gratuitous-expressions') maps to Sonar S#### keys
  // via the plugin's rule metadata docs.url. The mapping below uses the S#### keys.
  const ruleTypeMap: Record<string, 'BUG' | 'VULNERABILITY' | 'CODE_SMELL' | 'SECURITY_HOTSPOT'> = {
    // BUG rules
    'S2589': 'BUG', // Always-true/false condition (no-gratuitous-expressions)
    'S3923': 'BUG', // All branches are identical (no-all-duplicated-branches)
    'S2757': 'BUG', // Non-existent operator
    'S2681': 'BUG', // Duplicated key in object literal
    'S2091': 'BUG', // Never-used variable

    // CODE_SMELL rules (most common)
    'S1854': 'CODE_SMELL', // Dead store
    'S2970': 'CODE_SMELL', // Constructor returns value
    'S3972': 'CODE_SMELL', // No unused local variable
    'S3973': 'CODE_SMELL', // Empty conditional block
    'S3374': 'CODE_SMELL', // Constructor returns value
    'S1120': 'CODE_SMELL', // Function complexity
    'S1128': 'CODE_SMELL', // Unused imports
    'S1438': 'CODE_SMELL', // Alphabet ordering
    'S1226': 'CODE_SMELL', // Shadowed variable
    'S3358': 'CODE_SMELL', // Nested ternary
    'S1533': 'CODE_SMELL', // Getter/setter symmetry
    'S106': 'CODE_SMELL', // Console usage
    'S127': 'CODE_SMELL', // Nested depth
    'S817': 'CODE_SMELL', // Loop variable condition
    'S1126': 'CODE_SMELL', // Early return
    'S1135': 'CODE_SMELL', // No incomplete tasks in comments

    // VULNERABILITY rules
    'S5693': 'VULNERABILITY', // Disabled cert validation
    'S1313': 'VULNERABILITY', // Hard-coded IP/host
    'S2631': 'VULNERABILITY', // Path traversal
    'S6300': 'VULNERABILITY', // Unvalidated user input

    // SECURITY_HOTSPOT rules
    'S5542': 'SECURITY_HOTSPOT', // Use secure hash
    'S4790': 'SECURITY_HOTSPOT', // Hash without salt
    'S2092': 'SECURITY_HOTSPOT', // Auth/sensitive data in logs
  };

  // Try to extract the S#### key from the URL to look it up
  const sonarKey = extractSonarRuleKey(_ruleId, ruleMetadata);
  if (ruleTypeMap[sonarKey]) {
    return ruleTypeMap[sonarKey];
  }

  // Default to CODE_SMELL for unknown rules (most common in SonarJS)
  return 'CODE_SMELL';
}

/**
 * Run the TypeScript analyzer on the given files using ESLint + eslint-plugin-sonarjs.
 * Returns a map of file path -> Issue[] with Sonar-classified findings.
 */
export async function runTypeScriptAnalyzer(
  filePaths: string[],
  cwd: string = process.cwd(),
): Promise<Map<string, Issue[]>> {
  const results = new Map<string, Issue[]>();

  try {
    // Create an in-memory flat config with sonarjs recommended rules
    const eslint = new ESLint({
      baseConfig: [
        {
          languageOptions: {
            parser: typescriptEslintParser,
            parserOptions: {
              ecmaVersion: 2022,
              sourceType: 'module',
              project: false, // Disable type-aware linting for speed; set to tsconfig path if needed
            },
          },
          files: ['**/*.ts', '**/*.tsx'],
        },
        // Load sonarjs recommended config
        sonarjsPlugin.configs.recommended,
      ],
      cwd,
      overrideConfigFile: true, // Use only the baseConfig, don't load eslint.config.js from cwd
    });

    // Lint all files at once
    const lintResults = await eslint.lintFiles(filePaths);

    // Build a rule metadata lookup from the plugin
    const _allRules = sonarjsPlugin.rules || {};

    // Process each file's results
    for (const result of lintResults) {
      const fileIssues: Issue[] = [];

      for (const message of result.messages) {
        const ruleId = message.ruleId || 'unknown';

        // Look up rule metadata to get proper Sonar classification
        const ruleName = ruleId.startsWith('sonarjs/') ? ruleId.slice(8) : ruleId;
        const ruleMetadata = _allRules[ruleName as keyof typeof _allRules];

        // Extract the real Sonar S#### key from the rule metadata URL
        const sonarRuleId = extractSonarRuleKey(ruleId, ruleMetadata?.meta);

        const issue: Issue = {
          ruleId: sonarRuleId,
          ruleName: ruleName,
          type: mapToSonarType(ruleId, ruleMetadata?.meta),
          severity: mapToSonarSeverity(message.severity, ruleId, _allRules),
          line: message.line,
          column: message.column,
          message: message.message,
        };

        fileIssues.push(issue);
      }

      results.set(result.filePath, fileIssues);
    }
  } catch (error) {
    // Log the error but don't crash — this allows partial results
    console.error(`Error running TypeScript analyzer:`, error);
  }

  return results;
}
