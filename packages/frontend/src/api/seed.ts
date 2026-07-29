import { apiRequest } from './projects';

type SeedItemState = 'pending' | 'applied' | 'confirmed' | 'blocked';

interface SeedItemSource {
  sourceTaskId: string;
  sourceTaskTitle: string;
  mergeCommit?: string;
  addedAt: string;
}

interface SeedItemEvent {
  outcome: 'applied' | 'confirmed' | 'blocked';
  evidence?: unknown;
  filedFollowon?: string;
  operator?: string;
  at: string;
}

export interface SeedItem {
  id: string;
  project: string;
  milestone: string;
  spec: string;
  minDeployedCommit?: string;
  state: SeedItemState;
  updatedAt: string;
  sources: SeedItemSource[];
  events: SeedItemEvent[];
}

interface SeedBlockingItem {
  id: string;
  project: string;
  milestone: string;
  spec: string;
  state: string;
}

export interface SeedReadiness {
  status: 'green' | 'blocked';
  blocking: SeedBlockingItem[];
  /** The milestone's full per-state item totals, independent of any table filter. */
  counts: Record<string, number>;
}

export interface SeedMilestoneReadiness {
  project: string;
  milestone: string;
  status: 'green' | 'blocked';
  blockingCount: number;
}

export interface ListSeedItemsParams {
  project?: string;
  milestone?: string;
  state?: string;
  page?: number;
  limit?: number;
  order?: 'not-done-first';
}

export interface ListSeedItemsResult {
  items: SeedItem[];
  total: number;
  page: number;
}

function buildQuery(params: object): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}

export const seedApi = {
  getSeedReadiness(project: string, milestone: string): Promise<SeedReadiness> {
    return apiRequest<SeedReadiness>(
      `/api/seed/readiness${buildQuery({ project, milestone })}`,
    );
  },

  listSeedMilestoneReadiness(
    project?: string,
  ): Promise<SeedMilestoneReadiness[]> {
    return apiRequest<SeedMilestoneReadiness[]>(
      `/api/seed/milestones/readiness${buildQuery({ project })}`,
    );
  },

  listSeedItems(
    params: ListSeedItemsParams = {},
  ): Promise<ListSeedItemsResult> {
    return apiRequest<ListSeedItemsResult>(
      `/api/seed/items${buildQuery(params)}`,
    );
  },
};
