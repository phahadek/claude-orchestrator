/**
 * Shared test-authoring detection for 🧪 Testing task bodies. A 🧪 Testing task
 * folds into `/ops` only as observational / E2E work (task-writing.md §
 * 🧪 Testing); test-authoring carries an explicit `Mode: 🧪 Testing · authoring`
 * marker in the page body, absent which we default to observational (fold in).
 *
 * Single source of truth for both ops/opsLoad.ts (dispatch-time exclusion) and
 * groom/typeCheck.ts (grooming-time smuggling flag) — do not fork this regex.
 */
export function isTestAuthoring(markdown: string): boolean {
  const m = markdown.match(
    /mode\s*:.*testing.*?(authoring|observational|e2e|end[-\s]?to[-\s]?end)/is,
  );
  return !!m && /authoring/i.test(m[1]);
}
