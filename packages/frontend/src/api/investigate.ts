import { apiRequest } from './projects';

export interface InvestigateLaunchResult {
  sessionId: string;
  reportIds: string[];
}

/** Thin client over routes/investigate.ts — mirrors gateApi.dispatchVerification's launch-batch shape. */
export const investigateApi = {
  /** The operator-triggered dispatch of a batch of committed reports (the 'Investigate Selected' launcher). */
  launch(reportIds: string[]): Promise<InvestigateLaunchResult> {
    return apiRequest<InvestigateLaunchResult>('/api/investigate/launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reportIds }),
    });
  },
};
