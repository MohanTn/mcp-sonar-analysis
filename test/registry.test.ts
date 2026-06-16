/**
 * Unit tests for the global registry module (src/dashboard/registry.ts).
 * Tests reading, writing, and upserting registry entries.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getDashboardHomeDir,
  readRegistry,
  upsertRegistryEntry,
  removeRegistryEntry,
} from '../src/dashboard/registry.js';
import type { RegistryEntry } from '../src/types.js';

let tmpDir: string;

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mcp-sonar-registry-test-'));
});

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

test('getDashboardHomeDir creates directory if missing', () => {
  const homeDir = getDashboardHomeDir(tmpDir);
  assert.equal(homeDir, tmpDir);
  // Directory should exist after call (created if it didn't)
  assert.ok(existsSync(homeDir), 'Home dir should be created');
});

test('readRegistry returns { repos: [] } for missing file without throwing', () => {
  const testHome = join(tmpDir, 'empty-registry');
  const registry = readRegistry(testHome);
  assert.deepEqual(registry, { repos: [] }, 'Should return empty registry for missing file');
});

test('readRegistry returns { repos: [] } and logs warning for unparseable JSON', () => {
  const testHome = join(tmpDir, 'broken-registry');
  // Create directory and write invalid JSON
  mkdirSync(testHome, { recursive: true });
  const registryPath = join(testHome, 'registry.json');
  writeFileSync(registryPath, 'not valid json {', 'utf-8');

  // Suppress console.error for this test
  const originalError = console.error;
  let errorLogged = false;
  console.error = (msg: unknown) => {
    if (String(msg).includes('failed to read registry.json')) {
      errorLogged = true;
    }
  };

  try {
    const registry = readRegistry(testHome);
    assert.deepEqual(registry, { repos: [] }, 'Should return empty registry on parse error');
    assert.ok(errorLogged, 'Should have logged a warning');
  } finally {
    console.error = originalError;
  }
});

test('readRegistry returns { repos: [] } and logs warning if repos field is missing', () => {
  const testHome = join(tmpDir, 'invalid-structure');
  mkdirSync(testHome, { recursive: true });
  const registryPath = join(testHome, 'registry.json');
  writeFileSync(registryPath, JSON.stringify({ notRepos: [] }), 'utf-8');

  const originalError = console.error;
  let errorLogged = false;
  console.error = (msg: unknown) => {
    if (String(msg).includes('invalid structure')) {
      errorLogged = true;
    }
  };

  try {
    const registry = readRegistry(testHome);
    assert.deepEqual(registry, { repos: [] }, 'Should return empty registry on invalid structure');
    assert.ok(errorLogged, 'Should have logged a warning');
  } finally {
    console.error = originalError;
  }
});

test('upsertRegistryEntry writes a new entry to the registry', () => {
  const testHome = join(tmpDir, 'write-entry');
  const entry: RegistryEntry = {
    repoId: 1,
    path: '/home/user/project-a',
    name: 'project-a',
    dbPath: '/home/user/project-a/.mcp-sonar-analysis/db.sqlite',
    registeredAt: '2026-06-14T10:30:00.000Z',
  };

  upsertRegistryEntry(entry, testHome);

  const registry = readRegistry(testHome);
  assert.equal(registry.repos.length, 1, 'Registry should have one entry');
  assert.deepEqual(registry.repos[0], entry, 'Entry should match what was written');
});

test('upsertRegistryEntry: reading it back matches the written entry', () => {
  const testHome = join(tmpDir, 'roundtrip-entry');
  const entry: RegistryEntry = {
    repoId: 2,
    path: '/home/user/project-b',
    name: 'project-b',
    dbPath: '/home/user/project-b/.mcp-sonar-analysis/db.sqlite',
    registeredAt: '2026-06-14T11:00:00.000Z',
  };

  upsertRegistryEntry(entry, testHome);
  const registry = readRegistry(testHome);

  assert.equal(registry.repos.length, 1);
  assert.equal(registry.repos[0].path, '/home/user/project-b');
  assert.equal(registry.repos[0].name, 'project-b');
  assert.equal(registry.repos[0].repoId, 2);
});

test('upsertRegistryEntry: upserting same path twice results in exactly one entry (updated)', () => {
  const testHome = join(tmpDir, 'upsert-same-path');
  const path = '/home/user/project-c';

  const entry1: RegistryEntry = {
    repoId: 3,
    path,
    name: 'old-name',
    dbPath: '/home/user/project-c/.mcp-sonar-analysis/db.sqlite',
    registeredAt: '2026-06-14T10:00:00.000Z',
  };

  const entry2: RegistryEntry = {
    repoId: 3,
    path,
    name: 'new-name',
    dbPath: '/home/user/project-c/.mcp-sonar-analysis/db.sqlite',
    registeredAt: '2026-06-14T10:00:00.000Z',
  };

  upsertRegistryEntry(entry1, testHome);
  upsertRegistryEntry(entry2, testHome);

  const registry = readRegistry(testHome);
  assert.equal(registry.repos.length, 1, 'Should have exactly one entry after upserting same path');
  assert.equal(registry.repos[0].name, 'new-name', 'Entry should be updated with new name');
});

test('upsertRegistryEntry: multiple entries with different paths all persist', () => {
  const testHome = join(tmpDir, 'multiple-entries');

  const entry1: RegistryEntry = {
    repoId: 1,
    path: '/path/a',
    name: 'a',
    dbPath: '/path/a/.mcp-sonar-analysis/db.sqlite',
    registeredAt: '2026-06-14T10:00:00.000Z',
  };

  const entry2: RegistryEntry = {
    repoId: 2,
    path: '/path/b',
    name: 'b',
    dbPath: '/path/b/.mcp-sonar-analysis/db.sqlite',
    registeredAt: '2026-06-14T10:01:00.000Z',
  };

  const entry3: RegistryEntry = {
    repoId: 3,
    path: '/path/c',
    name: 'c',
    dbPath: '/path/c/.mcp-sonar-analysis/db.sqlite',
    registeredAt: '2026-06-14T10:02:00.000Z',
  };

  upsertRegistryEntry(entry1, testHome);
  upsertRegistryEntry(entry2, testHome);
  upsertRegistryEntry(entry3, testHome);

  const registry = readRegistry(testHome);
  assert.equal(registry.repos.length, 3, 'Registry should have all three entries');
  assert.ok(registry.repos.some((r) => r.path === '/path/a'));
  assert.ok(registry.repos.some((r) => r.path === '/path/b'));
  assert.ok(registry.repos.some((r) => r.path === '/path/c'));
});

test('removeRegistryEntry: removes an existing entry by path', () => {
  const testHome = join(tmpDir, 'remove-entry');
  const entry1: RegistryEntry = {
    repoId: 1,
    path: '/path/to-remove',
    name: 'to-remove',
    dbPath: '/path/to-remove/.mcp-sonar-analysis/db.sqlite',
    registeredAt: '2026-06-14T10:00:00.000Z',
  };
  const entry2: RegistryEntry = {
    repoId: 2,
    path: '/path/to-keep',
    name: 'to-keep',
    dbPath: '/path/to-keep/.mcp-sonar-analysis/db.sqlite',
    registeredAt: '2026-06-14T10:01:00.000Z',
  };

  upsertRegistryEntry(entry1, testHome);
  upsertRegistryEntry(entry2, testHome);

  // Verify both exist before removal
  let registry = readRegistry(testHome);
  assert.equal(registry.repos.length, 2, 'Should have 2 entries before removal');

  removeRegistryEntry('/path/to-remove', testHome);

  registry = readRegistry(testHome);
  assert.equal(registry.repos.length, 1, 'Should have 1 entry after removal');
  assert.equal(registry.repos[0].path, '/path/to-keep', 'Remaining entry should be the one we kept');
});

test('removeRegistryEntry: non-existent path is a no-op', () => {
  const testHome = join(tmpDir, 'remove-noop');
  const entry: RegistryEntry = {
    repoId: 1,
    path: '/path/exists',
    name: 'exists',
    dbPath: '/path/exists/.mcp-sonar-analysis/db.sqlite',
    registeredAt: '2026-06-14T10:00:00.000Z',
  };

  upsertRegistryEntry(entry, testHome);

  // Remove a non-existent path — should not throw or change anything
  removeRegistryEntry('/path/does-not-exist', testHome);

  const registry = readRegistry(testHome);
  assert.equal(registry.repos.length, 1, 'Entry should still be present');
  assert.equal(registry.repos[0].path, '/path/exists');
});

test('removeRegistryEntry: empty registry is a no-op', () => {
  const testHome = join(tmpDir, 'remove-empty');
  // Registry file doesn't exist yet — remove should be a no-op
  removeRegistryEntry('/anything', testHome);

  const registry = readRegistry(testHome);
  assert.deepEqual(registry, { repos: [] }, 'Registry should still be empty');
});

test('upsertRegistryEntry never throws to caller (swallows errors and logs warning)', () => {
  // Create a regular file, then use a path *inside* it as the "home dir" —
  // mkdirSync/writeFileSync will fail with ENOTDIR regardless of which user
  // runs the test (unlike relying on permission bits on a fixed system path).
  const blockerFile = join(tmpDir, 'not-a-directory');
  writeFileSync(blockerFile, 'i am a file, not a directory', 'utf-8');
  const testHome = join(blockerFile, 'nested', 'path');

  const entry: RegistryEntry = {
    repoId: 99,
    path: '/test/path',
    name: 'test',
    dbPath: '/test/path/.mcp-sonar-analysis/db.sqlite',
    registeredAt: '2026-06-14T10:00:00.000Z',
  };

  const originalError = console.error;
  let warningLogged = false;
  console.error = (msg: unknown) => {
    if (String(msg).includes('failed to upsert registry entry')) {
      warningLogged = true;
    }
  };

  try {
    // Should not throw, even though the directory is unwritable
    upsertRegistryEntry(entry, testHome);
    assert.ok(warningLogged, 'Should have logged a warning on write failure');
  } finally {
    console.error = originalError;
  }
});
