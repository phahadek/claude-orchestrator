import { apiRequest } from './projects';

type DeployRunStatus = 'running' | 'succeeded' | 'failed' | 'aborted';

export interface DeployRun {
  run_id: string;
  project: string;
  target_sha: string;
  current_step: string | null;
  status: DeployRunStatus;
  started_at: string;
  completed_at: string | null;
}

export interface DeployRunEvent {
  id: number;
  run_id: string;
  step: string;
  event_type: string;
  disposition: string | null;
  detail: string | null;
  at: string;
}

export interface DeployStatus {
  run: DeployRun | null;
  events: DeployRunEvent[];
}

export const deployApi = {
  launch(projectId: string): Promise<{ run: DeployRun }> {
    return apiRequest<{ run: DeployRun }>('/api/deploy/launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId }),
    });
  },

  getStatus(projectId: string): Promise<DeployStatus> {
    return apiRequest<DeployStatus>(
      `/api/deploy/status?projectId=${encodeURIComponent(projectId)}`,
    );
  },
};
