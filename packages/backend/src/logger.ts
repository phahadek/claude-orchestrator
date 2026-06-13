import fs from 'fs';
import path from 'path';
import { getDataDir } from './config/dataDir';

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB per file
const MAX_ROTATIONS = 5; // orchestrator.log.1 … orchestrator.log.5

let logDir = '';
let logPath = '';
let logFd: number | null = null;
let currentBytes = 0;
let _maxBytesOverride: number | null = null; // injected by tests only

// Originals saved so _resetForTesting can restore them.
let _origLog: typeof console.log | null = null;
let _origWarn: typeof console.warn | null = null;
let _origError: typeof console.error | null = null;
let _origDebug: typeof console.debug | null = null;

function closeFd(): void {
  if (logFd !== null) {
    try {
      fs.closeSync(logFd);
    } catch {
      // ignore errors on close
    }
    logFd = null;
  }
}

function openFd(): void {
  fs.mkdirSync(logDir, { recursive: true });
  try {
    currentBytes = fs.statSync(logPath).size;
  } catch {
    currentBytes = 0;
  }
  logFd = fs.openSync(logPath, 'a');
}

function rotate(): void {
  // Must close before renaming — Windows won't rename open files.
  closeFd();

  // Shift existing rotated files: .5 deleted, .4→.5, …, .1→.2, current→.1
  for (let i = MAX_ROTATIONS; i >= 1; i--) {
    const dest = `${logPath}.${i}`;
    const src = i === 1 ? logPath : `${logPath}.${i - 1}`;
    if (fs.existsSync(src)) {
      if (fs.existsSync(dest)) fs.unlinkSync(dest);
      fs.renameSync(src, dest);
    }
  }

  openFd();
}

function write(level: string, args: unknown[]): void {
  if (logFd === null) return;
  const timestamp = new Date().toISOString();
  const message = args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
  const line = `${timestamp} [${level.padEnd(5)}] ${message}\n`;
  const buf = Buffer.from(line);
  currentBytes += buf.byteLength;
  fs.writeSync(logFd, buf);
  if (currentBytes >= (_maxBytesOverride ?? MAX_BYTES)) rotate();
}

/**
 * Thin wrapper so call sites can import { logger } instead of calling console.*
 * directly. Delegates at call time so it picks up the patched console methods
 * installed by initLogger(). logger.info routes through console.log (the only
 * patched INFO-level method) so both console.log and console.info callers get
 * file output after initLogger() runs.
 */
export const logger = {
  info: (...args: unknown[]) => console.log(...args),
  warn: (...args: unknown[]) => console.warn(...args),
  error: (...args: unknown[]) => console.error(...args),
  debug: (...args: unknown[]) => console.debug(...args),
};

/**
 * Wire up rotating-file output for all console methods.
 * Log files land in <dataDir>/logs/orchestrator.log and rotate at 10 MB,
 * keeping up to 5 backups (.1 … .5).  Must be called once at startup.
 */
export function initLogger(): void {
  logPath = path.join(getDataDir(), 'logs', 'orchestrator.log');
  logDir = path.dirname(logPath);
  openFd();

  _origLog = console.log.bind(console);
  _origWarn = console.warn.bind(console);
  _origError = console.error.bind(console);
  _origDebug = console.debug.bind(console);

  console.log = (...args: unknown[]) => {
    _origLog!(...args);
    write('INFO', args);
  };
  console.warn = (...args: unknown[]) => {
    _origWarn!(...args);
    write('WARN', args);
  };
  console.error = (...args: unknown[]) => {
    _origError!(...args);
    write('ERROR', args);
  };
  console.debug = (...args: unknown[]) => {
    _origDebug!(...args);
    write('DEBUG', args);
  };

  process.on('exit', () => closeFd());
  process.on('SIGINT', () => {
    closeFd();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    closeFd();
    process.exit(0);
  });
}

/** Override the rotation threshold — for unit tests only. */
export function _setMaxBytesForTesting(n: number): void {
  _maxBytesOverride = n;
}

/** Reset module state and restore console — for unit tests only. */
export function _resetForTesting(): void {
  closeFd();
  currentBytes = 0;
  logDir = '';
  logPath = '';
  _maxBytesOverride = null;

  if (_origLog) console.log = _origLog;
  if (_origWarn) console.warn = _origWarn;
  if (_origError) console.error = _origError;
  if (_origDebug) console.debug = _origDebug;

  _origLog = null;
  _origWarn = null;
  _origError = null;
  _origDebug = null;
}
