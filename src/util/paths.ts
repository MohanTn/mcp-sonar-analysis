import { sep } from 'node:path';

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
