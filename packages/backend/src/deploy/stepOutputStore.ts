import fs from 'fs';
import path from 'path';
import { getDataDir } from '../config/dataDir';
import { logger } from '../logger';

export const STEP_OUTPUT_MAX_BYTES = 16 * 1024 * 1024;
const STEP_OUTPUT_RETAIN_RUNS = 100;

const SAFE_SEGMENT = /^[A-Za-z0-9_.-]+$/;

function outputRoot(dataDir: string): string {
  return path.join(dataDir, 'deploy-output');
}

function safeSegment(value: string): string {
  if (!SAFE_SEGMENT.test(value) || value === '.' || value === '..') {
    throw new Error(`unsafe path segment: ${value}`);
  }
  return value;
}

/** <dataDir>/deploy-output/<project>/<runId>/<stepId>.log */
export function stepOutputPath(
  project: string,
  runId: string,
  stepId: string,
  dataDir: string = getDataDir(),
): string {
  return path.join(
    outputRoot(dataDir),
    safeSegment(project),
    safeSegment(runId),
    `${safeSegment(stepId)}.log`,
  );
}

function boundBytes(output: string): Buffer {
  const buf = Buffer.from(output, 'utf8');
  if (buf.length <= STEP_OUTPUT_MAX_BYTES) return buf;
  const half = Math.floor(STEP_OUTPUT_MAX_BYTES / 2);
  const elided = buf.length - half * 2;
  return Buffer.concat([
    buf.subarray(0, half),
    Buffer.from(`\n... [${elided} bytes elided] ...\n`, 'utf8'),
    buf.subarray(buf.length - half),
  ]);
}

/** Atomic write; never throws — logs and returns false on failure. */
export function writeStepOutput(
  project: string,
  runId: string,
  stepId: string,
  output: string,
  dataDir: string = getDataDir(),
): boolean {
  try {
    const file = stepOutputPath(project, runId, stepId, dataDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, boundBytes(output));
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    logger.warn(
      `[stepOutputStore] failed to write ${project}/${runId}/${stepId}: ${String(err)}`,
    );
    return false;
  }
}

export function readStepOutput(
  project: string,
  runId: string,
  stepId: string,
  dataDir: string = getDataDir(),
): string | null {
  try {
    return fs.readFileSync(
      stepOutputPath(project, runId, stepId, dataDir),
      'utf8',
    );
  } catch {
    return null;
  }
}

/** Removes the oldest run dirs for a project beyond `keep`. Never throws. */
export function pruneStepOutputs(
  project: string,
  keep: number = STEP_OUTPUT_RETAIN_RUNS,
  dataDir: string = getDataDir(),
): void {
  try {
    const dir = path.join(outputRoot(dataDir), safeSegment(project));
    if (!fs.existsSync(dir)) return;
    const runs = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => ({
        name: e.name,
        mtime: fs.statSync(path.join(dir, e.name)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? 1 : -1));
    for (const old of runs.slice(Math.max(0, keep))) {
      fs.rmSync(path.join(dir, old.name), { recursive: true, force: true });
    }
  } catch (err) {
    logger.warn(`[stepOutputStore] prune failed for ${project}: ${String(err)}`);
  }
}
