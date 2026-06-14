import { sep, relative } from 'node:path';
import type { FileLanguage } from '../types.js';

/**
 * Returns true if `child` is `parent` itself or a path nested inside
 * `parent`, using a separator-aware check.
 *
 * A naive `child.startsWith(parent)` is not sufficient: if `parent` is
 * `/repo/Foo` and `child` is `/repo/FooBar/Baz.ts`, `startsWith` returns
 * `true` even though `FooBar` is a sibling directory, not a child of `Foo`.
 * This caused `relative()` to produce `../`-escaping repo-relative paths
 * that were persisted into the DB.
 *
 * Both `parent` and `child` are expected to already be normalized/resolved
 * absolute paths (e.g. via `path.resolve`).
 */
export function isPathInside(child: string, parent: string): boolean {
  if (child === parent) {
    return true;
  }
  const parentWithSep = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(parentWithSep);
}

/** Resolve a (possibly absolute or outside-repo) path to a repo-relative path. */
export function normalizeRelFilePath(filePath: string, repoRoot: string): string {
  if (isPathInside(filePath, repoRoot)) {
    return relative(repoRoot, filePath);
  }
  if (filePath.startsWith('/')) {
    return filePath.slice(1);
  }
  return filePath;
}

/** Determine the analyzer language from a repo-relative file path's extension. */
export function detectLanguage(relFilePath: string): FileLanguage {
  if (relFilePath.endsWith('.ts') || relFilePath.endsWith('.tsx')) {
    return 'typescript';
  }
  if (relFilePath.endsWith('.cs')) {
    return 'csharp';
  }
  return 'unknown';
}
