import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { initSchema } from '../src/db/schema.js';
import { openDb, getDbPath } from '../src/db/connection.js';
import {
  findRepoByPath,
  insertRepo,
  updateRepoStatus,
  upsertFileIssues,
  getFileIssues,
  upsertFileDependencies,
  getFileDependencies,
  getReverseDependencies,
  recordAnalysisRun,
  countIssuesByType,
  countDependencies,
  hasFileBeenAnalyzed,
} from '../src/db/queries.js';
import type { Issue, DependencyEdge } from '../src/types.js';

let tmpDir: string;

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mcp-sonar-db-test-'));
});

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

test('initSchema is idempotent - running twice on same DB does not error', () => {
  const db = new Database(':memory:');
  initSchema(db);
  initSchema(db); // should not throw
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as Array<{ name: string }>;
  const names = tables.map((t) => t.name);
  assert.ok(names.includes('analysis_repo'));
  assert.ok(names.includes('file_issues'));
  assert.ok(names.includes('file_dependencies'));
  assert.ok(names.includes('analysis_runs'));
  db.close();
});

test('openDb creates .mcp-sonar-analysis/db.sqlite under repo root and enables WAL', () => {
  const repoRoot = mkdtempSync(join(tmpDir, 'repo-'));
  const db = openDb(repoRoot);
  const journalMode = db.pragma('journal_mode', { simple: true });
  assert.equal(journalMode, 'wal');

  const expectedPath = getDbPath(repoRoot);
  assert.ok(expectedPath.endsWith('.mcp-sonar-analysis/db.sqlite'));
  db.close();
});

test('insertRepo + findRepoByPath: insert then lookup returns same record', () => {
  const db = new Database(':memory:');
  initSchema(db);

  const path = '/some/repo/path';
  const created = insertRepo(db, path, 'my-repo');
  assert.equal(created.path, path);
  assert.equal(created.name, 'my-repo');
  assert.equal(created.status, 'pending');

  const found = findRepoByPath(db, path);
  assert.ok(found);
  assert.equal(found?.id, created.id);
  assert.equal(found?.path, path);
  db.close();
});

test('insertRepo is rejected by UNIQUE constraint on duplicate path (idempotency enforced at DB layer)', () => {
  const db = new Database(':memory:');
  initSchema(db);
  insertRepo(db, '/dup/path');
  assert.throws(() => insertRepo(db, '/dup/path'), /UNIQUE constraint failed/);
  db.close();
});

test('updateRepoStatus updates status and last_analyzed_at', () => {
  const db = new Database(':memory:');
  initSchema(db);
  const repo = insertRepo(db, '/status/repo');
  updateRepoStatus(db, repo.id, 'success', '2026-01-01T00:00:00Z');
  const updated = findRepoByPath(db, '/status/repo');
  assert.equal(updated?.status, 'success');
  assert.equal(updated?.lastAnalyzedAt, '2026-01-01T00:00:00Z');
  db.close();
});

test('upsertFileIssues: insert, then re-upsert replaces prior issues (no duplicates)', () => {
  const db = new Database(':memory:');
  initSchema(db);
  const repo = insertRepo(db, '/issues/repo');

  const issuesV1: Issue[] = [
    { ruleId: 'S1854', type: 'CODE_SMELL', severity: 'MAJOR', line: 10, column: 5, message: 'dead store' },
    { ruleId: 'S2589', type: 'BUG', severity: 'MAJOR', line: 20, column: 1, message: 'always true' },
  ];
  upsertFileIssues(db, repo.id, 'src/foo.ts', issuesV1);

  let issues = getFileIssues(db, repo.id, 'src/foo.ts');
  assert.equal(issues.length, 2);

  // Re-run with only one issue (simulating the other being fixed)
  const issuesV2: Issue[] = [
    { ruleId: 'S1854', type: 'CODE_SMELL', severity: 'MAJOR', line: 10, column: 5, message: 'dead store' },
  ];
  upsertFileIssues(db, repo.id, 'src/foo.ts', issuesV2);

  issues = getFileIssues(db, repo.id, 'src/foo.ts');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].ruleId, 'S1854');

  db.close();
});

test('countIssuesByType aggregates correctly across types', () => {
  const db = new Database(':memory:');
  initSchema(db);
  const repo = insertRepo(db, '/count/repo');

  upsertFileIssues(db, repo.id, 'a.ts', [
    { ruleId: 'S1', type: 'BUG', severity: 'MAJOR', line: 1, column: 1 },
    { ruleId: 'S2', type: 'CODE_SMELL', severity: 'MINOR', line: 2, column: 1 },
  ]);
  upsertFileIssues(db, repo.id, 'b.ts', [
    { ruleId: 'S3', type: 'BUG', severity: 'BLOCKER', line: 1, column: 1 },
    { ruleId: 'S4', type: 'SECURITY_HOTSPOT', severity: 'CRITICAL', line: 3, column: 1 },
  ]);

  const counts = countIssuesByType(db, repo.id);
  assert.equal(counts.BUG, 2);
  assert.equal(counts.CODE_SMELL, 1);
  assert.equal(counts.SECURITY_HOTSPOT, 1);
  assert.equal(counts.VULNERABILITY, 0);
  db.close();
});

test('upsertFileDependencies + getFileDependencies + getReverseDependencies', () => {
  const db = new Database(':memory:');
  initSchema(db);
  const repo = insertRepo(db, '/deps/repo');

  const edges: DependencyEdge[] = [
    { sourceFile: 'src/a.ts', importedModule: './b', importedFile: 'src/b.ts', resolved: true, language: 'typescript' },
    { sourceFile: 'src/a.ts', importedModule: 'lodash', resolved: false, language: 'typescript' },
  ];
  upsertFileDependencies(db, repo.id, 'src/a.ts', edges);

  const deps = getFileDependencies(db, repo.id, 'src/a.ts');
  assert.equal(deps.length, 2);

  const reverse = getReverseDependencies(db, repo.id, 'src/b.ts');
  assert.deepEqual(reverse, ['src/a.ts']);

  assert.equal(countDependencies(db, repo.id), 2);

  // Re-upsert with fewer edges replaces prior set
  upsertFileDependencies(db, repo.id, 'src/a.ts', [edges[0]]);
  assert.equal(getFileDependencies(db, repo.id, 'src/a.ts').length, 1);

  db.close();
});

test('recordAnalysisRun inserts a row and returns its id', () => {
  const db = new Database(':memory:');
  initSchema(db);
  const repo = insertRepo(db, '/runs/repo');

  const runId = recordAnalysisRun(db, {
    repoId: repo.id,
    runType: 'full_repo',
    startedAt: '2026-01-01T00:00:00Z',
    completedAt: '2026-01-01T00:00:05Z',
    durationMs: 5000,
    filesAnalyzed: 10,
    issuesFound: 3,
  });
  assert.ok(runId > 0);

  const row = db.prepare('SELECT * FROM analysis_runs WHERE id = ?').get(runId) as {
    repo_id: number;
    run_type: string;
    files_analyzed: number;
  };
  assert.equal(row.repo_id, repo.id);
  assert.equal(row.run_type, 'full_repo');
  assert.equal(row.files_analyzed, 10);
  db.close();
});

test('hasFileBeenAnalyzed reflects presence of issue or dependency rows', () => {
  const db = new Database(':memory:');
  initSchema(db);
  const repo = insertRepo(db, '/analyzed/repo');

  assert.equal(hasFileBeenAnalyzed(db, repo.id, 'src/x.ts'), false);

  upsertFileIssues(db, repo.id, 'src/x.ts', []);
  // zero issues but dependency row exists
  upsertFileDependencies(db, repo.id, 'src/x.ts', [
    { sourceFile: 'src/x.ts', importedModule: './y', resolved: false, language: 'typescript' },
  ]);
  assert.equal(hasFileBeenAnalyzed(db, repo.id, 'src/x.ts'), true);

  db.close();
});

test('file_issues type CHECK constraint rejects invalid type', () => {
  const db = new Database(':memory:');
  initSchema(db);
  const repo = insertRepo(db, '/check/repo');
  assert.throws(() => {
    db.prepare(`
      INSERT INTO file_issues (repo_id, file_path, rule_id, type, severity, line, column)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(repo.id, 'x.ts', 'S1', 'NOT_A_TYPE', 'MAJOR', 1, 1);
  }, /CHECK constraint failed/);
  db.close();
});
