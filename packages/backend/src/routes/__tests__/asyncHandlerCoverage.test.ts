import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';

// Every async route handler registered under packages/backend/src/routes/
// must be wrapped in asyncHandler (see ../asyncHandler.ts) — Express 4 does
// not forward a rejected promise from a bare async handler to error
// middleware, so an unwrapped one silently hangs the request on failure.
// This statically scans every route module's source for the codebase's
// handler signature convention — `async (req...` / `async (_req...` — and
// asserts each occurrence is immediately preceded by `asyncHandler(`, so a
// newly added handler can never silently opt out of the boundary.

const ROUTES_DIR = path.join(__dirname, '..');

function listRouteFiles(): string[] {
  return fs
    .readdirSync(ROUTES_DIR)
    .filter((f) => f.endsWith('.ts'))
    .filter((f) => fs.statSync(path.join(ROUTES_DIR, f)).isFile());
}

const ASYNC_HANDLER_SIGNATURE_RE = /async\s*\(\s*(?:_req|req)\b/g;

function findUnwrappedHandlerLines(source: string): number[] {
  const unwrapped: number[] = [];
  ASYNC_HANDLER_SIGNATURE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ASYNC_HANDLER_SIGNATURE_RE.exec(source))) {
    const preceding = source.slice(0, match.index).replace(/\s+$/, '');
    if (!preceding.endsWith('asyncHandler(')) {
      unwrapped.push(source.slice(0, match.index).split('\n').length);
    }
  }
  return unwrapped;
}

describe('every async route handler is wrapped in asyncHandler', () => {
  const files = listRouteFiles();

  it('scans a non-empty set of route modules', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  for (const file of files) {
    it(`${file} registers no bare unwrapped async (req...) handler`, () => {
      const source = fs.readFileSync(path.join(ROUTES_DIR, file), 'utf8');
      const unwrappedLines = findUnwrappedHandlerLines(source);
      expect(unwrappedLines).toEqual([]);
    });
  }
});
