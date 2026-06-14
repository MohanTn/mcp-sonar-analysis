/**
 * Unit tests for src/util/paths.ts — the separator-aware path-containment
 * check used throughout src/core/* to normalize absolute paths to
 * repo-relative paths and to find a file's containing .csproj.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPathInside } from '../src/util/paths.js';

test('isPathInside: true when child equals parent', () => {
  assert.equal(isPathInside('/repo/Foo', '/repo/Foo'), true);
});

test('isPathInside: true when child is nested inside parent', () => {
  assert.equal(isPathInside('/repo/Foo/Bar.ts', '/repo/Foo'), true);
  assert.equal(isPathInside('/repo/Foo/a/b/c.ts', '/repo/Foo'), true);
});

test('isPathInside: false for sibling directories with a name-prefix collision', () => {
  // /repo/FooBar is NOT inside /repo/Foo, even though the string
  // "/repo/FooBar" starts with the string "/repo/Foo".
  assert.equal(isPathInside('/repo/FooBar/Baz.ts', '/repo/Foo'), false);
  assert.equal(isPathInside('/repo/FooBar', '/repo/Foo'), false);
});

test('isPathInside: false for unrelated paths', () => {
  assert.equal(isPathInside('/other/Foo.ts', '/repo/Foo'), false);
});

test('isPathInside: handles parent paths with a trailing separator', () => {
  assert.equal(isPathInside('/repo/Foo/Bar.ts', '/repo/Foo/'), true);
  assert.equal(isPathInside('/repo/FooBar/Baz.ts', '/repo/Foo/'), false);
});
