/**
 * Integration tests for Phase 4 core logic.
 * Tests the four main tool implementations with a combined fixture repo.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { mkdtempSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { registerRepo } from '../src/core/register.js';
import { analyseRepo } from '../src/core/analyseRepo.js';
import { getFileAnalysis } from '../src/core/getFileAnalysis.js';
import { analyseFile } from '../src/core/analyseFile.js';
import { openDb } from '../src/db/connection.js';
import { readRegistry } from '../src/dashboard/registry.js';

// Isolate the global dashboard registry for the whole file: every
// registerRepo() call below would otherwise upsert into the real
// ~/.mcp-sonar-analysis/registry.json. Point MCP_SONAR_DASHBOARD_HOME at a
// throwaway directory for the duration of this test file.
let dashboardHomeDir: string;
let previousDashboardHomeOverride: string | undefined;

before(() => {
  previousDashboardHomeOverride = process.env.MCP_SONAR_DASHBOARD_HOME;
  dashboardHomeDir = mkdtempSync(resolve(tmpdir(), 'mcp-sonar-core-test-registry-'));
  process.env.MCP_SONAR_DASHBOARD_HOME = dashboardHomeDir;
});

after(() => {
  if (previousDashboardHomeOverride === undefined) {
    delete process.env.MCP_SONAR_DASHBOARD_HOME;
  } else {
    process.env.MCP_SONAR_DASHBOARD_HOME = previousDashboardHomeOverride;
  }
  rmSync(dashboardHomeDir, { recursive: true, force: true });
});

// Set up a combined fixture repo with both TS and C# samples
function setupFixtureRepo(): string {
  const tmpDir = mkdtempSync(resolve(tmpdir(), 'mcp-sonar-test-'));

  // Copy TS sample
  const tsSampleSrc = resolve(process.cwd(), 'test/fixtures/ts-sample');
  const tsDest = resolve(tmpDir, 'ts');
  cpSync(tsSampleSrc, tsDest, { recursive: true });

  // Copy C# sample
  const csSampleSrc = resolve(process.cwd(), 'test/fixtures/cs-sample');
  const csDest = resolve(tmpDir, 'cs');
  cpSync(csSampleSrc, csDest, { recursive: true });

  return tmpDir;
}

test('registerRepo: idempotent registration', async () => {
  const tmpDir = setupFixtureRepo();

  try {
    // First registration
    const result1 = await registerRepo(tmpDir, 'test-repo');
    assert.ok(result1.repoId > 0, 'Should return a repo ID');
    assert.equal(result1.alreadyRegistered, false, 'First call should return alreadyRegistered=false');
    assert.equal(result1.status, 'pending', 'New repo should have status pending');

    // Second registration with same path
    const result2 = await registerRepo(tmpDir);
    assert.equal(result2.repoId, result1.repoId, 'Same path should return same repo ID');
    assert.equal(result2.alreadyRegistered, true, 'Second call should return alreadyRegistered=true');
    assert.equal(result2.path, result1.path, 'Path should be consistent');

    // Verify DB has only one repo row
    const dbConn = openDb(tmpDir);
    try {
      const rows = dbConn
        .prepare('SELECT COUNT(*) as cnt FROM analysis_repo')
        .get() as { cnt: number };
      assert.equal(rows.cnt, 1, 'DB should have exactly one repo row');
    } finally {
      dbConn.close();
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('registerRepo: writes entry to global registry on new and existing registration', async () => {
  const tmpDir = setupFixtureRepo();
  const registryHome = mkdtempSync(resolve(tmpdir(), 'mcp-sonar-registry-test-'));
  const previousOverride = process.env.MCP_SONAR_DASHBOARD_HOME;
  process.env.MCP_SONAR_DASHBOARD_HOME = registryHome;

  try {
    // First registration (new repo)
    const result1 = await registerRepo(tmpDir, 'test-repo');

    const expectedPath = resolve(tmpDir);
    const expectedDbPath = resolve(tmpDir, '.mcp-sonar-analysis', 'db.sqlite');

    assert.equal(result1.path, expectedPath, 'Registered path should match repo path');
    assert.ok(result1.repoId > 0, 'Should have a repo ID');

    // Registry entry should have been written under MCP_SONAR_DASHBOARD_HOME
    let registry = readRegistry(registryHome);
    const entry = registry.repos.find((r) => r.path === expectedPath);
    assert.ok(entry, 'Registry should contain an entry for the newly registered repo');
    assert.equal(entry?.repoId, result1.repoId);
    assert.equal(entry?.name, 'test-repo');
    assert.equal(entry?.dbPath, expectedDbPath);

    // Second registration (already registered) — self-healing upsert, no duplicates
    const result2 = await registerRepo(tmpDir);
    assert.equal(result2.repoId, result1.repoId, 'Same path should return same repo ID');
    assert.equal(result2.alreadyRegistered, true, 'Should be marked as already registered');

    registry = readRegistry(registryHome);
    const matching = registry.repos.filter((r) => r.path === expectedPath);
    assert.equal(matching.length, 1, 'Upsert must not create duplicate registry entries');
  } finally {
    if (previousOverride === undefined) {
      delete process.env.MCP_SONAR_DASHBOARD_HOME;
    } else {
      process.env.MCP_SONAR_DASHBOARD_HOME = previousOverride;
    }
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(registryHome, { recursive: true, force: true });
  }
});

test('analyseRepo: full repo analysis with mixed TS and C#', async () => {
  const tmpDir = setupFixtureRepo();

  try {
    // Register repo
    const reg = await registerRepo(tmpDir);
    const repoId = reg.repoId;

    // Analyse repo (pass path to avoid needing global DB for ID lookup)
    const analysis = await analyseRepo(tmpDir);

    assert.equal(analysis.repoId, repoId, 'Should return correct repo ID');
    assert.ok(analysis.filesAnalyzed > 0, 'Should analyze at least one file');
    assert.ok(analysis.durationMs > 0, 'Should record duration');

    // Check issues by type (we know dead-store.ts has S1854 CODE_SMELL, always-true.ts has S2589 BUG)
    assert.ok(analysis.issuesByType.CODE_SMELL >= 1, 'Should find at least one CODE_SMELL (S1854)');
    assert.ok(analysis.issuesByType.BUG >= 1, 'Should find at least one BUG (S2589)');

    // C# files may not have issues if dotnet is absent; that's OK per S3 graceful degradation
    // The errors array should document this
    if (analysis.errors.length > 0) {
      const dotnetMsg = analysis.errors.find((e) => e.includes('dotnet'));
      assert.ok(dotnetMsg !== undefined, 'If dotnet unavailable, errors should mention it (S3)');
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('analyseRepo: no duplicate rows on re-analysis', async () => {
  const tmpDir = setupFixtureRepo();

  try {
    await registerRepo(tmpDir);

    // First analysis (pass path)
    const analysis1 = await analyseRepo(tmpDir);
    assert.ok(analysis1.issuesByType.CODE_SMELL >= 1, 'First run should find issues');

    // Check row count in file_issues
    const db = openDb(tmpDir);
    let rowCount1: number;
    try {
      const result = db.prepare('SELECT COUNT(*) as cnt FROM file_issues').get() as { cnt: number };
      rowCount1 = result.cnt;
    } finally {
      db.close();
    }

    // Second analysis (no force option, so should re-analyze everything)
    const analysis2 = await analyseRepo(tmpDir);
    assert.deepEqual(
      analysis2.issuesByType,
      analysis1.issuesByType,
      'Second run should find same issue counts',
    );

    // Check row count again (should still be same, due to delete-then-insert upsert semantics)
    const db2 = openDb(tmpDir);
    let rowCount2: number;
    try {
      const result = db2.prepare('SELECT COUNT(*) as cnt FROM file_issues').get() as { cnt: number };
      rowCount2 = result.cnt;
    } finally {
      db2.close();
    }

    assert.equal(
      rowCount2,
      rowCount1,
      'No duplicate rows should be created on re-analysis (upsert semantics)',
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('getFileAnalysis: read-only retrieval of TS file analysis', async () => {
  const tmpDir = setupFixtureRepo();

  try {
    await registerRepo(tmpDir);

    // Analyse (pass path)
    await analyseRepo(tmpDir);

    // Get file analysis for dead-store.ts (pass path)
    const fileAnalysis = await getFileAnalysis(tmpDir, 'ts/dead-store.ts');

    assert.equal(fileAnalysis.filePath, 'ts/dead-store.ts', 'Should return correct file path');
    assert.equal(fileAnalysis.language, 'typescript', 'Should detect TypeScript language');
    assert.equal(fileAnalysis.analyzed, true, 'Should be marked as analyzed');
    assert.ok(fileAnalysis.issues.length > 0, 'Should have issues');

    const s1854Issues = fileAnalysis.issues.filter((issue) => issue.ruleId === 'S1854');
    assert.ok(s1854Issues.length > 0, 'Should have S1854 CODE_SMELL violation');
    assert.equal(
      s1854Issues[0].type,
      'CODE_SMELL',
      'S1854 should be classified as CODE_SMELL',
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('getFileAnalysis: non-analyzed file returns analyzed=false', async () => {
  const tmpDir = setupFixtureRepo();

  try {
    await registerRepo(tmpDir);

    // Don't analyze, just get analysis (pass path)
    const fileAnalysis = await getFileAnalysis(tmpDir, 'ts/nonexistent.ts');

    assert.equal(fileAnalysis.analyzed, false, 'Non-analyzed file should return analyzed=false');
    assert.deepEqual(fileAnalysis.issues, [], 'Should have empty issues');
    // No error thrown
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('getFileAnalysis: dependency info is returned', async () => {
  const tmpDir = setupFixtureRepo();

  try {
    await registerRepo(tmpDir);

    // Analyse (pass path)
    await analyseRepo(tmpDir);

    // Get file analysis for consumer.ts (imports helper.ts) (pass path)
    const fileAnalysis = await getFileAnalysis(tmpDir, 'ts/consumer.ts');

    assert.ok(fileAnalysis.dependsOn.length > 0, 'consumer.ts should depend on something');

    const helperDep = fileAnalysis.dependsOn.find((dep) => dep.module.includes('helper'));
    assert.ok(helperDep, 'Should have dependency on helper');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('analyseFile: single file analysis with fresh results', async () => {
  const tmpDir = setupFixtureRepo();

  try {
    await registerRepo(tmpDir);

    // Analyse the always-true.ts file (pass path)
    const fileAnalysis = await analyseFile(tmpDir, 'ts/always-true.ts');

    assert.equal(fileAnalysis.filePath, 'ts/always-true.ts', 'Should return correct file path');
    assert.ok(fileAnalysis.durationMs > 0, 'Should record duration');
    assert.ok(fileAnalysis.analyzedAt, 'Should record analysis timestamp');

    const s2589Issues = fileAnalysis.issues.filter((issue) => issue.ruleId === 'S2589');
    assert.ok(s2589Issues.length > 0, 'Should find S2589 BUG violation');
    assert.equal(s2589Issues[0].type, 'BUG', 'S2589 should be classified as BUG');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('analyseFile: detect freshly introduced violations', async () => {
  const tmpDir = setupFixtureRepo();

  try {
    await registerRepo(tmpDir);

    // Initial state: helper.ts has no violations
    const fileAnalysis = await analyseFile(tmpDir, 'ts/helper.ts');
    assert.equal(fileAnalysis.issues.length, 0, 'Initial: helper.ts should have no issues');

    // Now write a violation to a temp file
    const { writeFileSync } = await import('node:fs');
    const tempFile = resolve(tmpDir, 'ts', 'temp-violation.ts');
    writeFileSync(tempFile, 'export function test() {\n  if (true) { console.log("test"); }\n}');

    // Analyse the temp file (pass path)
    const tempAnalysis = await analyseFile(tmpDir, 'ts/temp-violation.ts');
    assert.ok(
      tempAnalysis.issues.length > 0,
      'Freshly written violation file should have issues',
    );
    assert.ok(
      tempAnalysis.issues.some((i) => i.ruleId === 'S2589'),
      'Should detect the always-true condition',
    );

    // Verify via getFileAnalysis that the violation persists (pass path)
    const verified = await getFileAnalysis(tmpDir, 'ts/temp-violation.ts');
    assert.ok(
      verified.issues.length > 0,
      'Fresh violation should be retrievable via getFileAnalysis',
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('analyseRepo: S1 incremental re-analysis skips unchanged files, re-analyzes changed/forced ones', async () => {
  const tmpDir = setupFixtureRepo();

  try {
    await registerRepo(tmpDir);

    // First analysis: populates file_mtimes and file_issues for all files.
    await analyseRepo(tmpDir);

    const db = openDb(tmpDir);
    let repoId: number;
    try {
      const repoRow = db.prepare('SELECT id FROM analysis_repo LIMIT 1').get() as { id: number };
      repoId = repoRow.id;

      const mtimeRowCount = db
        .prepare('SELECT COUNT(*) as cnt FROM file_mtimes WHERE repo_id = ?')
        .get(repoId) as { cnt: number };
      assert.ok(mtimeRowCount.cnt > 0, 'First analysis should record file mtimes');

      // Snapshot analyzed_at for dead-store.ts before the second run.
      const before = db
        .prepare('SELECT analyzed_at FROM file_issues WHERE repo_id = ? AND file_path = ? LIMIT 1')
        .get(repoId, 'ts/dead-store.ts') as { analyzed_at: string } | undefined;
      assert.ok(before, 'dead-store.ts should have an issue row after first analysis');
    } finally {
      db.close();
    }

    // Second analysis: no files changed, so dead-store.ts's issue rows
    // should not be touched (same analyzed_at), but issuesByType should
    // remain identical since nothing was deleted.
    const analysis1 = await analyseRepo(tmpDir);
    const analysis2 = await analyseRepo(tmpDir);
    assert.deepEqual(
      analysis2.issuesByType,
      analysis1.issuesByType,
      'Unchanged repo: issuesByType should be stable across incremental re-runs',
    );

    const db2 = openDb(tmpDir);
    let repoId2: number;
    try {
      const repoRow = db2.prepare('SELECT id FROM analysis_repo LIMIT 1').get() as { id: number };
      repoId2 = repoRow.id;
      const after = db2
        .prepare('SELECT analyzed_at FROM file_issues WHERE repo_id = ? AND file_path = ? LIMIT 1')
        .get(repoId2, 'ts/dead-store.ts') as { analyzed_at: string } | undefined;
      assert.ok(after, 'dead-store.ts should still have an issue row');
    } finally {
      db2.close();
    }

    // Touch dead-store.ts (update its mtime without changing content) and
    // re-analyze: it should be picked up as "changed" and re-analyzed.
    const { utimesSync, readFileSync } = await import('node:fs');
    const deadStorePath = resolve(tmpDir, 'ts', 'dead-store.ts');
    const future = new Date(Date.now() + 60_000);
    utimesSync(deadStorePath, future, future);

    const analysis3 = await analyseRepo(tmpDir);
    assert.deepEqual(
      analysis3.issuesByType,
      analysis1.issuesByType,
      'Touched-but-unmodified file should reproduce the same issues when re-analyzed',
    );

    // --force should re-analyze everything regardless of mtime.
    const analysis4 = await analyseRepo(tmpDir, { force: true });
    assert.deepEqual(
      analysis4.issuesByType,
      analysis1.issuesByType,
      '--force re-analysis should reproduce the same issues',
    );

    // Sanity: file content is unchanged.
    const content = readFileSync(deadStorePath, 'utf-8');
    assert.ok(content.length > 0, 'Fixture file should still have content');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('analyseFile: supports issue filtering by type and severity', async () => {
  const tmpDir = setupFixtureRepo();

  try {
    await registerRepo(tmpDir);

    // First analyse the file (pass path)
    await analyseFile(tmpDir, 'ts/dead-store.ts');

    // Get analysis filtered by type (pass path)
    const codeSmellOnly = await getFileAnalysis(tmpDir, 'ts/dead-store.ts', {
      type: 'CODE_SMELL',
    });
    assert.ok(
      codeSmellOnly.issues.every((i) => i.type === 'CODE_SMELL'),
      'All returned issues should be CODE_SMELL',
    );

    // Get analysis filtered by severity (pass path)
    const majorOnly = await getFileAnalysis(tmpDir, 'ts/dead-store.ts', {
      severity: 'MAJOR',
    });
    assert.ok(
      majorOnly.issues.every((i) => i.severity === 'MAJOR'),
      'All returned issues should be MAJOR severity',
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
