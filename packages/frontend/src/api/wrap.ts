import { apiRequest } from './projects';

type WrapRunStatus = 'running' | 'succeeded' | 'failed' | 'aborted';

export interface WrapRun {
  run_id: string;
  project: string;
  target_sha: string;
  current_step: string | null;
  status: WrapRunStatus;
  started_at: string;
  completed_at: string | null;
}

export interface WrapRunEvent {
  id: number;
  run_id: string;
  step: string;
  event_type: string;
  disposition: string | null;
  detail: string | null;
  at: string;
}

export interface WrapStatus {
  run: WrapRun | null;
  events: WrapRunEvent[];
}

export interface WrapLaunchParams {
  projectId: string;
  closingMilestoneId: string;
  nextMilestoneId: string;
  releaseVersion: string;
}

export const wrapApi = {
  launch(params: WrapLaunchParams): Promise<{ run: WrapRun }> {
    return apiRequest<{ run: WrapRun }>('/api/wrap/launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
  },

  confirm(
    runId: string,
    stepId: string,
    approved: boolean,
  ): Promise<{ runId: string; stepId: string; approved: boolean }> {
    return apiRequest<{ runId: string; stepId: string; approved: boolean }>(
      '/api/wrap/confirm',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId, stepId, approved }),
      },
    );
  },

  getStatus(projectId: string): Promise<WrapStatus> {
    return apiRequest<WrapStatus>(
      `/api/wrap/status?projectId=${encodeURIComponent(projectId)}`,
    );
  },
};
