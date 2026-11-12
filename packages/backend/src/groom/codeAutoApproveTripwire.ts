import { extractDeclaredWrites } from '../tasks/readinessGate';

export const TRIPWIRE_VERSION = 1;

type TripwireClass =
  | 'concurrency'
  | 'data-mutation'
  | 'auth'
  | 'ci-infra'
  | 'extra';

interface TripwireMatch {
  class: TripwireClass;
  term: string;
  source: 'path' | 'body';
  where: string;
}

export interface TripwireResult {
  matched: boolean;
  matches: TripwireMatch[];
  version: number;
}

export interface TripwireExtra {
  paths: string[];
  terms: string[];
}

interface TermSpec {
  class: Exclude<TripwireClass, 'extra'>;
  term: string;
  pattern: string;
}

// Non-alphanumeric characters (incl. `_`, `-`, `/`, `.`) count as word separators so
// `src/lock.ts` and `retry_policy` match; a trailing plural/inflection is tolerated.
const word = (p: string): RegExp =>
  new RegExp(`(?<![a-z0-9])(?:${p})(?:s|es|ed|ing)?(?![a-z0-9])`, 'i');

const TERMS: TermSpec[] = [
  ...[
    'lock',
    'mutex',
    'semaphore',
    'timeout',
    'retry|retries',
    'backoff',
    'queue',
    'worker',
    'scheduler',
    'cron',
    'rate[-_ ]?limit',
  ].map((p) => ({ class: 'concurrency' as const, term: p, pattern: p })),
  ...[
    'backfill',
    'migrate|migration',
    'delete',
    'purge',
    'truncate',
    'drop\\s+(?:table|database|schema|column|index|view)',
    'update\\s+[\\w."`]+\\s+set',
  ].map((p) => ({ class: 'data-mutation' as const, term: p, pattern: p })),
  ...[
    'auth',
    'permission',
    'capability|capabilities',
    'token',
    'credential',
    'secret',
    'role',
  ].map((p) => ({ class: 'auth' as const, term: p, pattern: p })),
];

const COMPILED_TERMS = TERMS.map((t) => ({
  ...t,
  re: word(t.pattern),
  label: t.term.split('|')[0].replace(/\[-_ \]\?/, '-').replace(/\\s\+/g, ' '),
}));

const CI_PATH_RES: Array<{ term: string; re: RegExp }> = [
  { term: '.github/workflows/', re: /(?:^|[/\\])\.github\/workflows\//i },
  { term: 'Dockerfile', re: /(?:^|\/)Dockerfile(?:\.[^/]*)?$/i },
  { term: 'docker-compose', re: /(?:^|\/)docker-compose[^/]*\.ya?ml$/i },
  { term: 'deploy/infra/terraform', re: /(?:^|\/)(?:deploy|infra|terraform)(?:\/|$)/i },
  { term: '*.tf', re: /\.tf(?:vars)?$/i },
  {
    term: 'root build/package config',
    re: /^(?:package(?:-lock)?\.json|tsconfig[^/]*\.json|(?:vite|vitest|webpack|rollup|eslint|knip)\.config\.[^/]+|\.claude-orchestrator\.yml)$/i,
  },
];

// Body-side counterparts: same files, mentioned by name rather than by full path.
const CI_BODY_RES: Array<{ term: string; re: RegExp }> = [
  { term: '.github/workflows/', re: /\.github\/workflows\//i },
  { term: 'Dockerfile', re: /(?<![a-z0-9])Dockerfile(?![a-z0-9])/i },
  { term: 'terraform', re: /(?<![a-z0-9])terraform(?![a-z0-9])/i },
  {
    term: 'root build/package config',
    re: /(?<![\w/-])(?:package(?:-lock)?\.json|tsconfig[\w.-]*\.json|\.claude-orchestrator\.yml)(?![\w])/i,
  },
];

function snippet(text: string, index: number, len: number): string {
  const start = Math.max(0, index - 20);
  return text
    .slice(start, index + len + 20)
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function evaluateTripwire(input: {
  paths: string[];
  body: string;
  extra?: TripwireExtra;
}): TripwireResult {
  const matches: TripwireMatch[] = [];
  const paths = input.paths.map((p) => p.replace(/\\/g, '/'));
  const body = input.body ?? '';

  for (const p of paths) {
    for (const t of COMPILED_TERMS) {
      if (t.re.test(p)) {
        matches.push({ class: t.class, term: t.label, source: 'path', where: p });
      }
    }
    for (const c of CI_PATH_RES) {
      if (c.re.test(p)) {
        matches.push({ class: 'ci-infra', term: c.term, source: 'path', where: p });
      }
    }
  }

  for (const t of COMPILED_TERMS) {
    const m = t.re.exec(body);
    if (m) {
      matches.push({
        class: t.class,
        term: t.label,
        source: 'body',
        where: snippet(body, m.index, m[0].length),
      });
    }
  }
  for (const c of CI_BODY_RES) {
    const m = c.re.exec(body);
    if (m) {
      matches.push({
        class: 'ci-infra',
        term: c.term,
        source: 'body',
        where: snippet(body, m.index, m[0].length),
      });
    }
  }

  const writes = extractDeclaredWrites(body);
  if (writes.length > 0) {
    matches.push({
      class: 'data-mutation',
      term: 'Declared writes',
      source: 'body',
      where: '## Declared writes',
    });
  }

  const extra = input.extra;
  if (extra) {
    for (const ep of extra.paths) {
      const needle = ep.trim().toLowerCase();
      if (!needle) continue;
      for (const p of paths) {
        if (p.toLowerCase().includes(needle)) {
          matches.push({ class: 'extra', term: ep, source: 'path', where: p });
        }
      }
    }
    for (const et of extra.terms) {
      const term = et.trim();
      if (!term) continue;
      const re = new RegExp(
        `(?<![a-z0-9])${escapeRegExp(term)}(?![a-z0-9])`,
        'i',
      );
      for (const p of paths) {
        if (re.test(p)) {
          matches.push({ class: 'extra', term, source: 'path', where: p });
        }
      }
      const m = re.exec(body);
      if (m) {
        matches.push({
          class: 'extra',
          term,
          source: 'body',
          where: snippet(body, m.index, m[0].length),
        });
      }
    }
  }

  return { matched: matches.length > 0, matches, version: TRIPWIRE_VERSION };
}
