import { describe, it, expect } from 'vitest';
import {
  CONSTRAINT_CATALOG,
  bindingConstraintIdsForRegions,
  matchesRegionGlob,
  resolvesCatalogEntry,
  unresolvedCatalogEntries,
  type ArchPageLike,
} from '../constraintCatalog';

/**
 * Keep-honest: build a fixture page per unique `page` title referenced by the
 * catalog, with a heading for every entry's `section` — independently of how
 * resolvesCatalogEntry itself normalizes text — and assert every entry
 * resolves. Catches a typo'd `page`/`section`, a duplicate id, or a resolver
 * regression; does not (cannot, in a unit test) assert the real Notion page
 * actually carries that heading.
 */
function buildFixturePages(): ArchPageLike[] {
  const byTitle = new Map<string, string[]>();
  for (const entry of CONSTRAINT_CATALOG) {
    const headings = byTitle.get(entry.page) ?? [];
    headings.push(`## ${entry.section}`);
    byTitle.set(entry.page, headings);
  }
  return [...byTitle.entries()].map(([title, headings]) => ({
    title,
    markdown: `# ${title}\n\n${headings.join('\n\nSome body text.\n\n')}\n`,
  }));
}

describe('CONSTRAINT_CATALOG', () => {
  it('has 15-25 entries with unique ids', () => {
    expect(CONSTRAINT_CATALOG.length).toBeGreaterThanOrEqual(15);
    expect(CONSTRAINT_CATALOG.length).toBeLessThanOrEqual(25);
    const ids = CONSTRAINT_CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every entry declares at least one appliesTo region glob', () => {
    for (const entry of CONSTRAINT_CATALOG) {
      expect(entry.appliesTo.length).toBeGreaterThan(0);
    }
  });

  it('every entry page/section resolves (keep-honest)', () => {
    const pages = buildFixturePages();
    expect(unresolvedCatalogEntries(pages)).toEqual([]);
    for (const entry of CONSTRAINT_CATALOG) {
      expect(resolvesCatalogEntry(entry, pages)).toBe(true);
    }
  });

  it('flags an entry whose section does not resolve against the fixture pages', () => {
    const pages = buildFixturePages();
    const fake = {
      id: 'fake',
      title: 'Fake',
      page: CONSTRAINT_CATALOG[0].page,
      section: 'Some Section That Does Not Exist',
      appliesTo: ['packages/backend/src/fake/**'],
      summary: 'n/a',
    };
    expect(resolvesCatalogEntry(fake, pages)).toBe(false);
    expect(unresolvedCatalogEntries([...pages])).toEqual([]);
  });

  it('flags an entry whose page is unknown', () => {
    const fake = {
      id: 'fake-page',
      title: 'Fake',
      page: 'Nonexistent Page',
      section: 'Anything',
      appliesTo: ['packages/backend/src/fake/**'],
      summary: 'n/a',
    };
    expect(resolvesCatalogEntry(fake, buildFixturePages())).toBe(false);
  });
});

describe('matchesRegionGlob', () => {
  it('matches a subtree glob against the package dir itself and files under it', () => {
    expect(
      matchesRegionGlob('packages/backend/src/gate/**', 'packages/backend/src/gate'),
    ).toBe(true);
    expect(
      matchesRegionGlob(
        'packages/backend/src/gate/**',
        'packages/backend/src/gate/gateStore.ts',
      ),
    ).toBe(true);
  });

  it('does not match a sibling directory that merely shares a prefix', () => {
    expect(
      matchesRegionGlob('packages/backend/src/gate/**', 'packages/backend/src/gateway'),
    ).toBe(false);
  });

  it('matches an exact literal glob only', () => {
    expect(
      matchesRegionGlob(
        'packages/backend/src/tasks/readinessGate.ts',
        'packages/backend/src/tasks/readinessGate.ts',
      ),
    ).toBe(true);
    expect(
      matchesRegionGlob(
        'packages/backend/src/tasks/readinessGate.ts',
        'packages/backend/src/tasks/other.ts',
      ),
    ).toBe(false);
  });
});

describe('bindingConstraintIdsForRegions', () => {
  it('returns the sorted, deduped set of constraint ids whose appliesTo intersects the regions', () => {
    const ids = bindingConstraintIdsForRegions({
      packages: ['packages/backend/src/gate', 'packages/backend/src/seed'],
      files: [],
    });
    expect(ids).toContain('gate-accretion-durable');
    expect(ids).toContain('seed-accretion-durable');
    expect(ids).toEqual([...ids].sort());
  });

  it('returns an empty array for regions touching no catalog entry', () => {
    expect(
      bindingConstraintIdsForRegions({ packages: ['packages/backend/src/nonexistent'], files: [] }),
    ).toEqual([]);
  });
});
