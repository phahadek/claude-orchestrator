import { minimatch } from "minimatch";
import { getRules, insertPermissionEvent } from "../db/queries";
import type { NewPermissionEvent } from "../db/types";
import type { Decision } from "./types";

// ─── Hard-coded rule lists ───────────────────────────────────────────────────
// toolArgs is a raw JSON string (e.g. {"command":"rm -rf /"}), so subject is
// `${toolName} ${toolArgs}`. Patterns use wildcards to match through the JSON
// wrapper regardless of argument structure.

const HARD_DENY = [
  "Bash *rm -rf*",
  "Bash *git push --force*main*",
  "Bash *git push --force*master*",
  "Bash *chmod -R 777*",
  "Bash *sudo rm*",
];

const HARD_ALLOW = [
  "Read *",
  "Bash *git status*",
  "Bash *git log*",
  "Bash *git diff*",
  "Bash *npx tsc*",
  "Bash *npx vitest*",
  "Bash *npm run *",
];

// ─── Pattern matching ────────────────────────────────────────────────────────

// Minimatch treats '/' as a path separator, but toolArgs is a raw JSON string
// that may contain slashes (file paths, URLs, etc.). We replace '/' with a
// private-use Unicode character in both subject and pattern before matching, so
// minimatch's '*' can traverse the full string. The substitute is unlikely to
// appear in real tool arguments.
const SLASH_SUB = "\uE000";

/**
 * Glob match via minimatch with '/' normalised out of path-separator role.
 */
function matchGlob(subject: string, pattern: string): boolean {
  return minimatch(
    subject.replace(/\//g, SLASH_SUB),
    pattern.replace(/\//g, SLASH_SUB),
    { dot: true, nocase: false },
  );
}

function matchPattern(
  subject: string,
  pattern: string,
  matchType: "glob" | "regex",
): boolean {
  if (matchType === "regex") {
    try {
      return new RegExp(pattern).test(subject);
    } catch {
      console.warn(
        `[PermissionEngine] Invalid regex pattern "${pattern}" — skipping`,
      );
      return false;
    }
  }
  return matchGlob(subject, pattern);
}

// ─── Engine ──────────────────────────────────────────────────────────────────

export class PermissionEngine {
  evaluate(toolName: string, toolArgs: string): Decision {
    const subject = `${toolName} ${toolArgs}`;

    // Tier 1 — hard deny
    if (HARD_DENY.some((p) => matchGlob(subject, p))) {
      this.record(toolName, toolArgs, "auto_deny", "hard_deny");
      return "deny";
    }

    // Tier 2 — hard allow (skip audit log to reduce noise)
    if (HARD_ALLOW.some((p) => matchGlob(subject, p))) {
      return "allow";
    }

    // Tier 3 — user rules from SQLite, already ordered by order_index
    const rules = getRules().filter((r) => r.enabled === 1);
    for (const rule of rules) {
      if (matchPattern(subject, rule.pattern, rule.match_type)) {
        const outcome = rule.decision === "allow" ? "auto_allow" : "auto_deny";
        this.record(toolName, toolArgs, outcome, rule.label ?? rule.pattern);
        return rule.decision;
      }
    }

    // Tier 4 — no match → escalate to UI
    this.record(toolName, toolArgs, "escalate", null);
    return "escalate";
  }

  /**
   * Extract tool names from HARD_ALLOW patterns and user "allow" rules.
   * Used by AgentSession to compute the --allowedTools flag for the CLI.
   */
  getAllowedToolNames(): string[] {
    const tools = new Set<string>();

    // Extract tool names from HARD_ALLOW patterns (first word before space)
    for (const p of HARD_ALLOW) {
      const name = p.split(" ")[0];
      if (name) tools.add(name);
    }

    // Extract tool names from user allow rules
    const rules = getRules().filter(
      (r) => r.enabled === 1 && r.decision === "allow",
    );
    for (const rule of rules) {
      const name = rule.pattern.split(" ")[0];
      if (name) tools.add(name);
    }

    return [...tools];
  }

  private record(
    toolName: string,
    toolArgs: string,
    decision: string,
    ruleMatched: string | null,
  ): void {
    // decision may be 'escalate' which is not in the PermissionDecision union,
    // but the underlying TEXT column accepts it. Cast via unknown to satisfy tsc.
    const event: NewPermissionEvent = {
      session_id: "",
      tool_name: toolName,
      proposed_action: toolArgs,
      decision: decision as unknown as NewPermissionEvent["decision"],
      rule_matched: ruleMatched,
      decided_at: Date.now(),
    };
    try {
      insertPermissionEvent(event);
    } catch (err) {
      // FK constraint fires when session_id is unknown. AgentSession is
      // responsible for wiring the session context; this is best-effort.
      console.warn(
        "[PermissionEngine] Could not write permission event:",
        (err as Error).message,
      );
    }
  }
}
