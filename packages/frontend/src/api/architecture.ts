import { apiRequest } from './projects';

export type ArchUnitKind =
  | 'subsystem'
  | 'invariant'
  | 'decision'
  | 'contract'
  | 'reference';

export type ArchUnitStatus = 'active' | 'deferred' | 'superseded';

export interface ArchUnit {
  id: string;
  title: string;
  kind: ArchUnitKind;
  topic: string;
  regions: string[];
  status: ArchUnitStatus;
  body: string;
  supersedes?: string;
  supersededBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ArchUnitEvent {
  eventType: string;
  payload?: unknown;
  at: string;
}

export interface ListArchUnitsParams {
  topic?: string;
  kind?: ArchUnitKind;
  region?: string;
  status?: ArchUnitStatus;
  includeSuperseded?: boolean;
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

export const architectureApi = {
  listUnits(params: ListArchUnitsParams = {}): Promise<ArchUnit[]> {
    return apiRequest<ArchUnit[]>(
      `/api/architecture/units${buildQuery(params)}`,
    );
  },

  getUnit(id: string): Promise<ArchUnit> {
    return apiRequest<ArchUnit>(
      `/api/architecture/units/${encodeURIComponent(id)}`,
    );
  },

  getUnitEvents(id: string): Promise<ArchUnitEvent[]> {
    return apiRequest<ArchUnitEvent[]>(
      `/api/architecture/units/${encodeURIComponent(id)}/events`,
    );
  },
};
