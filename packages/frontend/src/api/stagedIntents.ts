import { apiRequest } from './projects';

/**
 * A pending staged intent produced by a general command/stage surface (e.g.
 * Groom(N), Ops(N)). `kind` discriminates how `payload` is rendered and how
 * apply is dispatched server-side through TaskWriteCommands — the frontend
 * never interprets payload itself, it only displays and forwards it.
 */
export interface StagedIntent {
  id: string;
  kind: string;
  payload: unknown;
  projectId: string;
  createdAt: number;
}

export const stagedIntentsApi = {
  list(projectId?: string): Promise<StagedIntent[]> {
    const query = projectId
      ? `?projectId=${encodeURIComponent(projectId)}`
      : '';
    return apiRequest<{ intents: StagedIntent[] }>(
      `/api/staged-intents${query}`,
    ).then((res) => res.intents);
  },

  stage(
    kind: string,
    payload: unknown,
    projectId: string,
  ): Promise<StagedIntent> {
    return apiRequest<StagedIntent>('/api/staged-intents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, payload, projectId }),
    });
  },

  apply(id: string): Promise<{ ok: boolean; result: unknown }> {
    return apiRequest<{ ok: boolean; result: unknown }>(
      `/api/staged-intents/${encodeURIComponent(id)}/apply`,
      { method: 'POST' },
    );
  },

  reject(id: string): Promise<{ ok: boolean }> {
    return apiRequest<{ ok: boolean }>(
      `/api/staged-intents/${encodeURIComponent(id)}/reject`,
      { method: 'POST' },
    );
  },
};
