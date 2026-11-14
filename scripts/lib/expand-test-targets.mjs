import { readdirSync } from 'node:fs';
import path from 'node:path';

// Node 22+ treats a directory passed to `node --test` as a module, so expand each directory into its *.test.mjs files.
export function expandTestTargets(dirs, cwd = process.cwd()) {
  return dirs.flatMap((dir) =>
    readdirSync(path.resolve(cwd, dir))
      .filter((name) => name.endsWith('.test.mjs'))
      .sort()
      .map((name) => path.posix.join(dir.replace(/\/+$/, ''), name)),
  );
}
