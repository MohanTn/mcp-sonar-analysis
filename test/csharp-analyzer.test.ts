import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import {
  isDotnetAvailable,
  findCsprojFiles,
  runCsharpAnalyzer,
  runCsharpAnalyzerForFile,
  parseSarif,
} from '../src/analyzers/csharp.js';
import { runCsDependencyGraph } from '../src/analyzers/dependency-graph-cs.js';

const fixtureDir = resolve(process.cwd(), 'test/fixtures/cs-sample');
const sarifFixturePath = resolve(process.cwd(), 'test/fixtures/sample.sarif.json');

test('isDotnetAvailable: returns a boolean based on environment', async () => {
  const available = await isDotnetAvailable();
  assert.equal(typeof available, 'boolean', 'isDotnetAvailable should return a boolean');
  // The value depends on whether dotnet is installed — both outcomes are valid
  assert.ok(available === true || available === false, 'isDotnetAvailable should return true or false');
});

test('isDotnetAvailable: never throws', async () => {
  // This should resolve to a boolean without throwing, regardless of dotnet availability
  const result = await isDotnetAvailable();
  assert.equal(typeof result, 'boolean');
});

test('findCsprojFiles: discovers the fixture .csproj', async () => {
  const projects = await findCsprojFiles(fixtureDir);

  assert.ok(projects.length > 0, 'Should find at least one .csproj file');

  const csprojPath = projects.find((p) => p.includes('CsSample.csproj'));
  assert.ok(csprojPath, 'Should find CsSample.csproj fixture');
});

test('findCsprojFiles: returns absolute paths', async () => {
  const projects = await findCsprojFiles(fixtureDir);

  if (projects.length > 0) {
    for (const proj of projects) {
      assert.ok(proj.startsWith('/'), 'Project paths should be absolute');
    }
  }
});

test('runCsharpAnalyzer: gracefully degrades or runs when dotnet is (un)available', async () => {
  const dotnetAvailable = await isDotnetAvailable();
  const fixture = resolve(fixtureDir, 'CsSample.csproj');
  const result = await runCsharpAnalyzer([fixture], fixtureDir);

  assert.ok(result.issuesByFile instanceof Map, 'Should return a Map for issuesByFile');
  assert.ok(Array.isArray(result.errors), 'Should return an errors array');

  if (!dotnetAvailable) {
    // S3 graceful degradation: empty results + descriptive error
    assert.equal(result.issuesByFile.size, 0, 'issuesByFile should be empty when dotnet is unavailable');
    assert.ok(result.errors.length > 0, 'errors should mention dotnet unavailability (S3)');
    const errorText = result.errors.join(' ').toLowerCase();
    assert.ok(errorText.includes('dotnet') || errorText.includes('graceful'), 'Error should reference dotnet or graceful degradation');
  } else {
    // When dotnet IS available, the analyzer should produce results
    // (the fixture has deliberate violations like S1481, S2325)
    assert.ok(result.issuesByFile.size > 0 || result.errors.some((e) => e.includes('build failed')), 'Should either have issues or build errors');
  }
});

test('runCsharpAnalyzer: returns empty results without throwing when no projects given', async () => {
  const result = await runCsharpAnalyzer([], fixtureDir);

  assert.ok(result.issuesByFile instanceof Map);
  assert.ok(Array.isArray(result.errors));
});

test('parseSarif: extracts issues from hand-written SARIF fixture', () => {
  const sarifContent = readFileSync(sarifFixturePath, 'utf-8');
  const sarifJson = JSON.parse(sarifContent);

  const issuesByFile = parseSarif(sarifJson, fixtureDir);

  assert.ok(issuesByFile instanceof Map, 'Should return a Map');
  assert.ok(issuesByFile.size > 0, 'Should extract issues from fixture SARIF');
});

test('parseSarif: maps S1481 (unused variable) to CODE_SMELL', () => {
  const sarifContent = readFileSync(sarifFixturePath, 'utf-8');
  const sarifJson = JSON.parse(sarifContent);

  const issuesByFile = parseSarif(sarifJson, fixtureDir);

  const modelsIssues = issuesByFile.get('Models.cs');
  assert.ok(modelsIssues, 'Should find issues in Models.cs');

  const s1481Issues = modelsIssues.filter((i) => i.ruleId === 'S1481');
  assert.ok(s1481Issues.length > 0, 'Should find S1481 issues');

  const s1481 = s1481Issues[0];
  assert.equal(s1481.type, 'CODE_SMELL', 'S1481 should be CODE_SMELL');
  assert.equal(s1481.severity, 'MINOR', 'S1481 should have MINOR severity (from warning level)');
  assert.equal(s1481.line, 20, 'S1481 should be at line 20');
  assert.ok(s1481.message, 'S1481 should have a message');
});

test('parseSarif: maps S2486 (empty catch) to BUG', () => {
  const sarifContent = readFileSync(sarifFixturePath, 'utf-8');
  const sarifJson = JSON.parse(sarifContent);

  const issuesByFile = parseSarif(sarifJson, fixtureDir);

  const modelsIssues = issuesByFile.get('Models.cs');
  assert.ok(modelsIssues, 'Should find issues in Models.cs');

  const s2486Issues = modelsIssues.filter((i) => i.ruleId === 'S2486');
  assert.ok(s2486Issues.length > 0, 'Should find S2486 issues');

  const s2486 = s2486Issues[0];
  assert.equal(s2486.type, 'BUG', 'S2486 should be BUG');
  assert.equal(s2486.severity, 'MAJOR', 'S2486 should have MAJOR severity (from error level)');
  assert.equal(s2486.line, 31, 'S2486 should be at line 31');
});

test('parseSarif: maps S2589 (always-true) to BUG', () => {
  const sarifContent = readFileSync(sarifFixturePath, 'utf-8');
  const sarifJson = JSON.parse(sarifContent);

  const issuesByFile = parseSarif(sarifJson, fixtureDir);

  const servicesIssues = issuesByFile.get('Services.cs');
  assert.ok(servicesIssues, 'Should find issues in Services.cs');

  const s2589Issues = servicesIssues.filter((i) => i.ruleId === 'S2589');
  assert.ok(s2589Issues.length > 0, 'Should find S2589 issues');

  const s2589 = s2589Issues[0];
  assert.equal(s2589.type, 'BUG', 'S2589 should be BUG');
  assert.equal(s2589.severity, 'MAJOR', 'S2589 should have MAJOR severity');
  assert.equal(s2589.line, 19, 'S2589 should be at line 19');
});

test('parseSarif: preserves ruleId, line, column, and message', () => {
  const sarifContent = readFileSync(sarifFixturePath, 'utf-8');
  const sarifJson = JSON.parse(sarifContent);

  const issuesByFile = parseSarif(sarifJson, fixtureDir);

  for (const [, issues] of issuesByFile) {
    for (const issue of issues) {
      assert.ok(issue.ruleId, 'Every issue should have a ruleId');
      assert.match(issue.ruleId, /^S\d+$/, `Rule ID should be S#### format, got ${issue.ruleId}`);
      assert.ok(issue.type, 'Every issue should have a type');
      assert.ok(issue.severity, 'Every issue should have a severity');
      assert.ok(typeof issue.line === 'number', 'Every issue should have a line number');
      assert.ok(typeof issue.column === 'number', 'Every issue should have a column number');
      assert.ok(issue.message, 'Every issue should have a message');
    }
  }
});

test('parseSarif: handles empty SARIF document gracefully', () => {
  const emptySarif = { runs: [] };
  const result = parseSarif(emptySarif, fixtureDir);

  assert.ok(result instanceof Map);
  assert.equal(result.size, 0, 'Empty SARIF should produce empty result');
});

test('parseSarif: handles SARIF with no results gracefully', () => {
  const sarifNoResults = {
    runs: [
      {
        tool: { driver: { name: 'Test' } },
        results: [],
      },
    ],
  };
  const result = parseSarif(sarifNoResults, fixtureDir);

  assert.ok(result instanceof Map);
  assert.equal(result.size, 0, 'SARIF with empty results should produce empty result');
});

test('parseSarif: maps SARIF level to Sonar severity correctly', () => {
  const testSarif = {
    runs: [
      {
        tool: {
          driver: {
            rules: [
              { id: 'S1000', properties: { tags: ['code-smell'] } },
              { id: 'S2000', properties: { tags: ['bug'] } },
            ],
          },
        },
        results: [
          {
            ruleId: 'S1000',
            level: 'error',
            message: { text: 'Test error' },
            locations: [{ physicalLocation: { artifactLocation: { uri: 'test.cs' }, region: { startLine: 1 } } }],
          },
          {
            ruleId: 'S2000',
            level: 'warning',
            message: { text: 'Test warning' },
            locations: [{ physicalLocation: { artifactLocation: { uri: 'test.cs' }, region: { startLine: 2 } } }],
          },
        ],
      },
    ],
  };

  const result = parseSarif(testSarif, fixtureDir);
  const issues = result.get('test.cs') || [];

  assert.equal(issues.length, 2);
  assert.equal(issues[0].severity, 'MAJOR', 'error level should map to MAJOR');
  assert.equal(issues[1].severity, 'MINOR', 'warning level should map to MINOR');
});

test('runCsDependencyGraph: extracts using directives from fixture files', async () => {
  const csFiles = [
    resolve(fixtureDir, 'Models.cs'),
    resolve(fixtureDir, 'Services.cs'),
  ];

  const edges = await runCsDependencyGraph(csFiles, fixtureDir);

  assert.ok(Array.isArray(edges), 'Should return an array of DependencyEdge');
  assert.ok(edges.length > 0, 'Should find at least one dependency edge');
});

test('runCsDependencyGraph: Services.cs using CsSample.Models resolves correctly', async () => {
  const csFiles = [
    resolve(fixtureDir, 'Models.cs'),
    resolve(fixtureDir, 'Services.cs'),
  ];

  const edges = await runCsDependencyGraph(csFiles, fixtureDir);

  // Services.cs has `using CsSample.Models;`
  // Models.cs declares `namespace CsSample.Models;`
  // So we expect a resolved edge
  const servicesEdges = edges.filter((e) => e.sourceFile.includes('Services.cs'));
  assert.ok(servicesEdges.length > 0, 'Should find edges from Services.cs');

  const modelsImport = servicesEdges.find((e) => e.importedModule.includes('CsSample.Models'));
  assert.ok(modelsImport, 'Should find import of CsSample.Models');
  assert.equal(modelsImport.language, 'csharp', 'Language should be csharp');
  assert.equal(modelsImport.resolved, true, 'Should be marked as resolved');
  assert.ok(modelsImport.importedFile, 'Should have resolved file path');
  assert.ok(modelsImport.importedFile?.includes('Models.cs'), 'Should resolve to Models.cs');
});

test('runCsDependencyGraph: marks unresolved imports without error', async () => {
  // Create a temporary test .cs file with an unresolved using
  const tmpDir = resolve(process.cwd(), 'test/tmp-cs-test');
  const tmpCsFile = resolve(tmpDir, 'temp.cs');

  try {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(tmpCsFile, 'using NonExistent.Namespace;\n\nclass Test { }');

    const edges = await runCsDependencyGraph([tmpCsFile], tmpDir);
    const unresolved = edges.find((e) => e.importedModule === 'NonExistent.Namespace');

    assert.ok(unresolved, 'Should create edge for unresolved import');
    assert.equal(unresolved.resolved, false, 'Unresolved import should have resolved=false');
    assert.equal(unresolved.importedFile, undefined, 'Unresolved import should have no importedFile');
  } finally {
    // Cleanup
    try {
      rmSync(tmpDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  }
});

test('runCsDependencyGraph: excludes using static directives', async () => {
  const tmpDir = resolve(process.cwd(), 'test/tmp-cs-test-2');
  const tmpCsFile = resolve(tmpDir, 'temp.cs');

  try {
    mkdirSync(tmpDir, { recursive: true });
    // File with `using static` which should be ignored
    writeFileSync(
      tmpCsFile,
      `using System;
using static System.Math;
namespace Test;

class Program { }`,
    );

    const edges = await runCsDependencyGraph([tmpCsFile], tmpDir);

    // Should have System (from `using System;`) but not System.Math (from `using static`)
    const systemEdges = edges.filter((e) => e.importedModule === 'System');
    assert.ok(systemEdges.length > 0, 'Should extract regular using System');

    // System.Math should not be extracted (it's from `using static`)
    // This test verifies the regex correctly excludes `using static` patterns
    const systemMathEdges = edges.filter((e) => e.importedModule === 'System.Math');
    assert.equal(systemMathEdges.length, 0, 'Should not extract using static directives');
  } finally {
    try {
      rmSync(tmpDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  }
});

test('runCsharpAnalyzerForFile: handles dotnet (un)availability correctly', async () => {
  const dotnetAvailable = await isDotnetAvailable();
  const csprojPath = resolve(fixtureDir, 'CsSample.csproj');
  const result = await runCsharpAnalyzerForFile(csprojPath, fixtureDir);

  assert.ok(result.issuesByFile instanceof Map, 'Should return issuesByFile as a Map');
  assert.ok(Array.isArray(result.errors), 'Should return errors array');

  if (!dotnetAvailable) {
    assert.equal(result.issuesByFile.size, 0, 'Should have no per-file issues when dotnet is unavailable');
    assert.ok(result.errors.length > 0, 'Should have errors explaining why analysis was skipped');
  } else {
    // When dotnet IS available, the analyzer should produce results
    assert.ok(result.issuesByFile.size > 0 || result.errors.some((e) => e.includes('build failed')), 'Should either have issues or build errors');
  }
});
