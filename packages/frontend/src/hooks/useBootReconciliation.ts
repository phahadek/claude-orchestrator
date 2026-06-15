import { useState, useCallback, useRef, useEffect } from 'react';
import type { ServerMessage } from '@claude-orchestrator/backend/src/ws/types';

export interface BootStepEntry {
  name: string;
  status: 'started' | 'completed' | 'failed';
  duration_ms?: number;
  error?: string;
}

export interface BootReconciliationState {
  phase: 'idle' | 'in_progress' | 'completed';
  steps: string[];
  stepEntries: BootStepEntry[];
  currentStep: string | null;
  startedAt: string | null;
  totalDurationMs: number | null;
}

const INITIAL_STATE: BootReconciliationState = {
  phase: 'idle',
  steps: [],
  stepEntries: [],
  currentStep: null,
  startedAt: null,
  totalDurationMs: null,
};

export function useBootReconciliation() {
  const [state, setState] = useState<BootReconciliationState>(INITIAL_STATE);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, []);

  const dispatch = useCallback((msg: ServerMessage) => {
    if (msg.type === 'boot_reconciliation_started') {
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
      setState({
        phase: 'in_progress',
        steps: msg.steps,
        stepEntries: [],
        currentStep: null,
        startedAt: msg.started_at,
        totalDurationMs: null,
      });
      return;
    }

    if (msg.type === 'boot_reconciliation_step') {
      setState((prev) => {
        const entry: BootStepEntry = {
          name: msg.step,
          status: msg.status,
          duration_ms: msg.duration_ms,
          error: msg.error,
        };
        const currentStep =
          msg.status === 'started' ? msg.step : prev.currentStep;
        return {
          ...prev,
          stepEntries: [...prev.stepEntries, entry],
          currentStep:
            msg.status === 'completed' || msg.status === 'failed'
              ? prev.currentStep === msg.step
                ? null
                : prev.currentStep
              : currentStep,
        };
      });
      return;
    }

    if (msg.type === 'boot_reconciliation_completed') {
      setState((prev) => ({
        ...prev,
        phase: 'completed',
        currentStep: null,
        totalDurationMs: msg.duration_ms,
      }));
      hideTimerRef.current = setTimeout(() => {
        setState(INITIAL_STATE);
      }, 2000);
    }
  }, []);

  return { state, dispatch };
}
