/**
 * Guard: every mutation route (router.post|patch|put|delete) under
 * packages/backend/src/routes/ must be classified in routeAudience.ts, and
 * every route classified 'operator' must have a matching /api/... reference
 * somewhere under packages/frontend/src — otherwise a route ships that only
 * a messaged session can reach.
 */

import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import {
  ROUTE_AUDIENCE,
  ROUTE_FILE_MOUNT_PREFIX,
  normalizeRoutePath,
  joinMountPath,
} from '../routeAudience';

const ROUTES_DIR = path.join(__dirname, '..');
const FRONTEND_SRC_DIR = path.join(__dirname, '../../../../frontend/src');

const ROUTE_DECL_RE =
  /router\.(post|patch|put|delete)\(\s*(['"`])((?:(?!\2)[\s\S])*?)\2/g;

interface DiscoveredRoute {
  file: string;
  verb: string;
  fullPath: string;
}

function discoverBackendRoutes(): DiscoveredRoute[] {
  const files = fs
    .readdirSync(ROUTES_DIR)
    .filter((f) => f.endsWith('.ts') && !fs.statSync(path.join(ROUTES_DIR, f)).isDirectory());

  const routes: DiscoveredRoute[] = [];
  for (const file of files) {
    const content = fs.readFileSync(path.join(ROUTES_DIR, file), 'utf8');
    let match: RegExpExecArray | null;
    ROUTE_DECL_RE.lastIndex = 0;
    while ((match = ROUTE_DECL_RE.exec(content)) !== null) {
      const [, verb, , routePath] = match;
      const mountPrefix = ROUTE_FILE_MOUNT_PREFIX[file];
      if (mountPrefix === undefined) {
        throw new Error(
          `${file} declares a mutation route (${verb.toUpperCase()} ${routePath}) but has no entry in ROUTE_FILE_MOUNT_PREFIX — add its mount prefix from server.ts`,
        );
      }
      routes.push({
        file,
        verb: verb.toUpperCase(),
        fullPath: joinMountPath(mountPrefix, routePath),
      });
    }
  }
  return routes;
}

function collectFrontendApiPaths(): string[] {
  const paths: string[] = [];
  const literalRe = /['"`](\/api\/[^'"`]*)['"`]/g;

  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__tests__') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name) || /\.test\.(ts|tsx)$/.test(entry.name)) {
        continue;
      }
      const content = fs.readFileSync(full, 'utf8');
      let match: RegExpExecArray | null;
      literalRe.lastIndex = 0;
      while ((match = literalRe.exec(content)) !== null) {
        paths.push(match[1]);
      }
    }
  }

  walk(FRONTEND_SRC_DIR);
  return paths;
}

function isBoundInFrontend(fullPath: string, frontendPaths: string[]): boolean {
  const normalizedRoute = normalizeRoutePath(fullPath);
  return frontendPaths.some((p) => normalizeRoutePath(p) === normalizedRoute);
}

describe('routeAudience registry', () => {
  const backendRoutes = discoverBackendRoutes();
  const frontendPaths = collectFrontendApiPaths();

  it('classifies every mutation route under packages/backend/src/routes/', () => {
    const unclassified = backendRoutes
      .map((r) => `${r.verb} ${r.fullPath}`)
      .filter((key) => !ROUTE_AUDIENCE[key]);
    expect(unclassified).toEqual([]);
  });

  it('has a frontend binding for every route classified operator', () => {
    const unbound: string[] = [];
    for (const route of backendRoutes) {
      const key = `${route.verb} ${route.fullPath}`;
      const entry = ROUTE_AUDIENCE[key];
      if (!entry || entry.audience !== 'operator') continue;
      if (!isBoundInFrontend(route.fullPath, frontendPaths)) {
        unbound.push(key);
      }
    }
    expect(unbound).toEqual([]);
  });

  it('does not require a frontend binding for session/tooling routes', () => {
    const sessionOrTooling = backendRoutes.filter((r) => {
      const entry = ROUTE_AUDIENCE[`${r.verb} ${r.fullPath}`];
      return entry && (entry.audience === 'session' || entry.audience === 'tooling');
    });
    // These routes are legitimately unbound in the frontend; presence here
    // (rather than throwing during discovery) is the assertion.
    expect(sessionOrTooling.length).toBeGreaterThan(0);
  });

  it('records the two known-gap routes with their fix tasks', () => {
    const opsJournalEntry = ROUTE_AUDIENCE['POST /api/ops-journal/:taskId/state'];
    expect(opsJournalEntry?.audience).toBe('known-gap');
    expect(opsJournalEntry?.fixTask).toBeTruthy();

    const groupRecoverEntry =
      ROUTE_AUDIENCE['POST /api/staged-intents/group/:groupId/recover'];
    expect(groupRecoverEntry?.audience).toBe('known-gap');
    expect(groupRecoverEntry?.fixTask).toBeTruthy();
  });
});

describe('normalizeRoutePath / isBoundInFrontend', () => {
  it('ignores query strings when comparing paths', () => {
    const backendPath = '/api/tasks/:taskId/recover';
    const frontendCall =
      '/api/tasks/${encodeURIComponent(task.taskId)}/recover?projectId=${encodeURIComponent(project.id)}';
    // Naive string equality would fail here — the query string and the
    // encodeURIComponent(...) wrapper differ from the backend's :taskId.
    expect(backendPath === frontendCall).toBe(false);
    expect(isBoundInFrontend(backendPath, [frontendCall])).toBe(true);
  });

  it('treats :param and ${...} as equivalent wildcards', () => {
    const backendPath = '/api/gate/items/:id/approve';
    const frontendCall = '/api/gate/items/${encodeURIComponent(id)}/approve';
    expect(normalizeRoutePath(backendPath)).toBe(normalizeRoutePath(frontendCall));
    expect(isBoundInFrontend(backendPath, [frontendCall])).toBe(true);
  });

  it('compares exactly, not by prefix — an unbound route beneath a referenced base path stays unbound', () => {
    const referencedBasePath = '/api/staged-intents/group/${encodeURIComponent(groupId)}';
    const unboundSiblingRoute = '/api/staged-intents/group/:groupId/recover';
    expect(isBoundInFrontend(unboundSiblingRoute, [referencedBasePath])).toBe(false);
  });
});
