import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { runTypeScriptAnalyzer } from '../src/analyzers/typescript.js';
import { runTsDependencyGraph } from '../src/analyzers/dependency-graph-ts.js';

const fixtureDir = resolve(process.cwd(), 'test/fixtures/ts-sample');

test('TypeScript analyzer: detects S1854 (dead store) violation', async () => {
  const filePath = resolve(fixtureDir, 'dead-store.ts');
  const issues = await runTypeScriptAnalyzer([filePath]);

  assert.ok(issues.has(filePath), 'dead-store.ts should be in results');
  const fileIssues = issues.get(filePath) || [];

  const s1854Issues = fileIssues.filter((issue) => issue.ruleId === 'S1854');
  assert.ok(s1854Issues.length > 0, 'Should find at least one S1854 violation');

  const s1854 = s1854Issues[0];
  assert.equal(s1854.type, 'CODE_SMELL', 'S1854 should be classified as CODE_SMELL');
  // S1854 is configured as 'error' in sonarjs recommended config, which maps to 'MAJOR'
  assert.equal(s1854.severity, 'MAJOR', 'S1854 severity should be MAJOR (error-level in ESLint)');
  assert.ok(s1854.message, 'Should have a message');
  assert.ok(typeof s1854.line === 'number', 'Should have a line number');
});

test('TypeScript analyzer: always-true.ts has no remaining S2589 violation', async () => {
  const filePath = resolve(fixtureDir, 'always-true.ts');
  const issues = await runTypeScriptAnalyzer([filePath]);

  assert.ok(issues.has(filePath), 'always-true.ts should be in results');
  const fileIssues = issues.get(filePath) || [];

  const s2589Issues = fileIssues.filter((issue) => issue.ruleId === 'S2589');
  assert.equal(s2589Issues.length, 0, 'always-true.ts should have no S2589 violations after fix');
});

test('TypeScript analyzer: returns empty issues for files with no violations', async () => {
  const filePath = resolve(fixtureDir, 'helper.ts');
  const issues = await runTypeScriptAnalyzer([filePath]);

  assert.ok(issues.has(filePath), 'helper.ts should be in results');
  const fileIssues = issues.get(filePath) || [];

  // helper.ts has no deliberate violations
  assert.equal(fileIssues.length, 0, 'helper.ts should have no issues');
});

test('Dependency graph: extracts import edges between fixture files', async () => {
  const filePath = resolve(fixtureDir, 'consumer.ts');
  const edges = await runTsDependencyGraph([filePath]);

  assert.ok(edges.length > 0, 'Should find at least one dependency edge');

  // Note: dependency-cruiser returns relative paths from the working directory
  // The edge should have importedFile pointing to helper.ts since it's resolved
  const resolvedEdge = edges.find(
    (edge) => edge.sourceFile.includes('consumer.ts') && edge.importedModule.includes('helper'),
  );

  assert.ok(resolvedEdge, 'Should find import edge for consumer -> helper');
  assert.equal(resolvedEdge.language, 'typescript', 'Language should be typescript');
  assert.equal(resolvedEdge.resolved, true, 'Internal import should be marked as resolved');
  assert.ok(
    resolvedEdge.importedFile?.includes('helper'),
    'importedFile should reference helper.ts',
  );
});

test('Dependency graph: handles batch file analysis', async () => {
  const files = [
    resolve(fixtureDir, 'consumer.ts'),
    resolve(fixtureDir, 'helper.ts'),
  ];
  const edges = await runTsDependencyGraph(files);

  // Should find the consumer -> helper dependency
  const consumerToHelper = edges.filter(
    (edge) => edge.sourceFile.includes('consumer.ts') && edge.importedModule.includes('helper'),
  );

  assert.ok(consumerToHelper.length > 0, 'Should find consumer -> helper dependency in batch');
});

test('TypeScript analyzer: all rule IDs are in S#### format', async () => {
  const files = [
    resolve(fixtureDir, 'dead-store.ts'),
    resolve(fixtureDir, 'always-true.ts'),
  ];
  const issues = await runTypeScriptAnalyzer(files);

  for (const [, fileIssues] of issues) {
    for (const issue of fileIssues) {
      assert.match(
        issue.ruleId,
        /^S\d+$/,
        `Rule ID should be in S#### format, got ${issue.ruleId}`,
      );
    }
  }
});
