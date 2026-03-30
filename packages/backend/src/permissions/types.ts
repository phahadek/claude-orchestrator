export type Decision = 'allow' | 'deny' | 'escalate';

export interface PermissionRule {
  id: number;
  orderIndex: number;
  pattern: string;
  matchType: 'glob' | 'regex';
  decision: 'allow' | 'deny';
  label?: string;
  enabled: boolean;
}
