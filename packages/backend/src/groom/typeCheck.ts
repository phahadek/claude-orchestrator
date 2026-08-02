/**
 * type_check — deterministic keyword/heuristic scan for a task body whose
 * content doesn't match its declared Type ("smuggling"): a 💻 Code task
 * carrying operational-seed / investigation content that belongs on the
 * milestone config-seed / an Investigation task instead, or a 🔧 Operational /
 * 🔎 Investigation task carrying dispatchable code that should be split into
 * a 💻 Code task (see skills/groom/reference/presentation.md § Ready triggers).
 * Also covers 🧪 Testing's two floor facts (Clean-verdict standard for
 * 🧪 Testing and 📝 Docs promotion): the Manual verification section states
 * its disposition using the task-writing.md vocabulary, and the task isn't
 * test-authoring smuggled in as observational/E2E Testing.
 *
 * A keyword match is advisory only — it over-flags legitimate operational
 * mentions — so this never hard-blocks; the groomer records a disposition
 * (a split-off task, or a dismissal reason). LLM classification is Future
 * Scope; this is Tier-1 lexical matching only, same spirit as readinessGate's
 * deferral-phrase scan.
 */

import { isTestAuthoring } from '../tasks/testAuthoring';

export interface TypeCheckResult {
  decision: 'none' | 'flagged' | 'n/a';
  signals?: string[];
}

/** 💻 Code body carrying markers of operational-seed or investigation content. */
const OPERATIONAL_OR_INVESTIGATION_MARKERS: readonly RegExp[] = [
  /\boperational seed\b/i,
  /\bconfig-seed\b/i,
  /\bseed data\b/i,
  /\bprod-data\b/i,
  /\bproduction data\b/i,
  /\bapi key\b/i,
  /\bcredentials?\b/i,
  /\bsecrets?\b/i,
  /\binvestigate\b/i,
  /\bfigure out\b/i,
  /\bto be determined\b/i,
  /\btbd\b/i,
  /\bexplore options\b/i,
  /\bresearch (?:whether|how|what)\b/i,
];

/** 🔧 Operational / 🔎 Investigation body carrying dispatchable-code markers. */
const DISPATCHABLE_CODE_MARKERS: readonly RegExp[] = [
  /\bimplement (?:the |a |an )?(?:module|function|class|component|endpoint|method)\b/i,
  /\bwrite (?:the |a |an )?(?:function|module|class|component|script)\b/i,
  /\badd (?:a |an |the )?new (?:endpoint|route|component|function)\b/i,
  /\bcode the\b/i,
  /\brefactor (?:the )?(?:function|module|class|component)\b/i,
];

const TYPES_NEEDING_OPERATIONAL_SCAN = new Set(['💻 Code']);
const TYPES_NEEDING_CODE_SCAN = new Set(['🔧 Operational', '🔎 Investigation']);
const TYPES_NEEDING_TESTING_SCAN = new Set(['🧪 Testing']);

/** task-writing.md § 🧪 Testing's Manual verification disposition vocabulary. */
const DISPOSITION_VOCAB_PATTERN = /\b(pass-with-caveat|blocked-pending-fix|pass)\b/i;
const MANUAL_VERIFICATION_HEADING = /^#{1,6}\s*👁️\s*Manual verification\s*$/i;

/**
 * Blanks out fenced code blocks, inline code spans, and block-quoted lines so
 * matching only sees prose. Same approach as readinessGate.ts's stripNonProse.
 */
function stripNonProse(body: string): string[] {
  const lines = body.split('\n');
  const out: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      out.push('');
      continue;
    }
    if (inFence || /^\s*>/.test(line)) {
      out.push('');
      continue;
    }
    out.push(line.replace(/`[^`]*`/g, ''));
  }
  return out;
}

function findSignals(body: string, markers: readonly RegExp[]): string[] {
  const prose = stripNonProse(body).join('\n');
  const signals: string[] = [];
  for (const marker of markers) {
    const match = prose.match(marker);
    if (match) signals.push(match[0]);
  }
  return signals;
}

/** Isolates the `### 👁️ Manual verification` section's body, or null if absent. */
function extractManualVerificationSection(body: string): string | null {
  const lines = stripNonProse(body);
  const startIdx = lines.findIndex((line) =>
    MANUAL_VERIFICATION_HEADING.test(line.trim()),
  );
  if (startIdx === -1) return null;
  const rest = lines.slice(startIdx + 1);
  const endIdx = rest.findIndex((line) => /^#{1,6}\s/.test(line.trim()));
  return (endIdx === -1 ? rest : rest.slice(0, endIdx)).join('\n');
}

/**
 * 🧪 Testing floor facts (Clean-verdict standard for 🧪 Testing and 📝 Docs
 * promotion): the Manual verification section must state its disposition
 * using the task-writing.md vocabulary (not bare pass/fail language), and the
 * task must not be test-authoring smuggled in as observational/E2E Testing —
 * the latter reuses the same detection `/ops` already applies at dispatch
 * time (tasks/testAuthoring.ts) so the two checks never drift apart.
 */
function scanTestingType(body: string): TypeCheckResult {
  const signals: string[] = [];

  if (isTestAuthoring(body)) {
    signals.push('Mode: 🧪 Testing · authoring');
  }

  const section = extractManualVerificationSection(body);
  if (section !== null && !DISPOSITION_VOCAB_PATTERN.test(section)) {
    signals.push(
      'Manual verification section missing disposition vocabulary (pass / blocked-pending-fix / pass-with-caveat)',
    );
  }

  return signals.length > 0 ? { decision: 'flagged', signals } : { decision: 'none' };
}

/** Scan a task body for type/content mismatches. Exempt types return {decision: 'n/a'}. */
export function scanTypeCheck(
  type: string,
  body: string | null | undefined,
): TypeCheckResult {
  const text = body ?? '';
  if (TYPES_NEEDING_TESTING_SCAN.has(type)) return scanTestingType(text);

  const markers = TYPES_NEEDING_OPERATIONAL_SCAN.has(type)
    ? OPERATIONAL_OR_INVESTIGATION_MARKERS
    : TYPES_NEEDING_CODE_SCAN.has(type)
      ? DISPATCHABLE_CODE_MARKERS
      : null;
  if (!markers) return { decision: 'n/a' };

  const signals = findSignals(text, markers);
  return signals.length > 0
    ? { decision: 'flagged', signals }
    : { decision: 'none' };
}
