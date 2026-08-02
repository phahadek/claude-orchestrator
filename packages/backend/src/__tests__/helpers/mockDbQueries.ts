import { vi } from 'vitest';
import type * as QueriesModule from '../../db/queries';

/**
 * Builds a `vi.mock('../db/queries', ...)` replacement by spreading every
 * real export of db/queries and overriding only the ones a test cares
 * about. This keeps tests resilient to new db/queries exports — unlike an
 * exhaustive hand-rolled factory, adding an export to the real module can
 * never make an unrelated test fail with a "no export defined" error.
 */
export async function mockDbQueries<T extends Partial<typeof QueriesModule>>(
  overrides: T = {} as T,
): Promise<typeof QueriesModule> {
  const actual =
    await vi.importActual<typeof QueriesModule>('../../db/queries');
  return { ...actual, ...overrides };
}
