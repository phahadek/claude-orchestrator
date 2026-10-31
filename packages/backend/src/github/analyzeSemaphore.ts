import { Semaphore } from '../tasks/deferralClassifier';
import { typedGetSetting } from '../config/settings';

let analyzeSemaphore: Semaphore | null = null;

function getAnalyzeSemaphore(): Semaphore {
  const limit = typedGetSetting('analyze_max_concurrent');
  if (!analyzeSemaphore) {
    analyzeSemaphore = new Semaphore(limit);
  } else if (analyzeSemaphore.capacity() !== limit) {
    analyzeSemaphore.resize(limit);
  }
  return analyzeSemaphore;
}

/** Acquires a process-wide FIFO analyze permit sized by analyze_max_concurrent; returns the release function. */
export function acquireAnalyzePermit(): Promise<() => void> {
  return getAnalyzeSemaphore().acquire();
}

/** Applies a changed analyze_max_concurrent immediately so parked waiters are admitted without waiting for a new acquire. */
export function syncAnalyzeSemaphoreCapacity(): void {
  if (analyzeSemaphore) getAnalyzeSemaphore();
}

export function __resetAnalyzeSemaphoreForTest(): void {
  analyzeSemaphore = null;
}
