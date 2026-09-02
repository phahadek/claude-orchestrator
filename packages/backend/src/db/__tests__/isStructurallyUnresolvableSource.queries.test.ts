import { describe, it, expect, vi } from 'vitest';

vi.mock('../db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import {
  upsertTaskCache,
  isStructurallyUnresolvableSource,
} from '../queries.js';

describe('isStructurallyUnresolvableSource', () => {
  it('returns true for a 📐 Design source, without requiring any pull_requests row', () => {
    upsertTaskCache('notion:design-1', JSON.stringify({ type: '📐 Design' }));

    expect(isStructurallyUnresolvableSource('notion:design-1')).toBe(true);
  });

  it('returns true for a 🧪 Testing source, without requiring any pull_requests row', () => {
    upsertTaskCache('notion:testing-1', JSON.stringify({ type: '🧪 Testing' }));

    expect(isStructurallyUnresolvableSource('notion:testing-1')).toBe(true);
  });

  it('returns true for a 📋 Planning source, without requiring any pull_requests row', () => {
    upsertTaskCache('notion:planning-1', JSON.stringify({ type: '📋 Planning' }));

    expect(isStructurallyUnresolvableSource('notion:planning-1')).toBe(true);
  });

  it('returns true for a 📝 Docs source, without requiring any pull_requests row', () => {
    upsertTaskCache('notion:docs-1', JSON.stringify({ type: '📝 Docs' }));

    expect(isStructurallyUnresolvableSource('notion:docs-1')).toBe(true);
  });

  it('returns true for a 🎨 Assets source, without requiring any pull_requests row', () => {
    upsertTaskCache('notion:assets-1', JSON.stringify({ type: '🎨 Assets' }));

    expect(isStructurallyUnresolvableSource('notion:assets-1')).toBe(true);
  });

  it('returns true for a 🔎 Investigation source, without requiring any pull_requests row', () => {
    upsertTaskCache(
      'notion:investigation-1',
      JSON.stringify({ type: '🔎 Investigation' }),
    );

    expect(isStructurallyUnresolvableSource('notion:investigation-1')).toBe(
      true,
    );
  });

  it('returns false for a 💻 Code source', () => {
    upsertTaskCache('notion:code-1', JSON.stringify({ type: '💻 Code' }));

    expect(isStructurallyUnresolvableSource('notion:code-1')).toBe(false);
  });
});
