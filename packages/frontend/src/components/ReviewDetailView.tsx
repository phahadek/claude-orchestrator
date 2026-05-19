import type { SessionState } from "../hooks/useSessionStore";
import styles from "./ReviewDetailView.module.css";

// ── Types ─────────────────────────────────────────────────────────

export interface ReviewDimension {
  name: string;
  passed: boolean;
  notes: string;
}

export interface ReviewResult {
  verdict: "approved" | "needs_changes" | "incomplete" | "error";
  dimensions: ReviewDimension[];
  summary: string;
}

// ── Client-side review result parser ─────────────────────────────

function extractJsonCandidate(text: string): string | null {
  const fenceMatch = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
  if (fenceMatch) return fenceMatch[1].trim();

  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export function parseReviewResultFromEvents(
  events: SessionState["events"],
): ReviewResult | null {
  // Find the last assistant text event's content parts
  let lastTextParts: string[] = [];
  for (const event of events) {
    if (event.eventType !== "text") continue;
    try {
      const payload = JSON.parse(event.content) as Record<string, unknown>;
      if (payload.type !== "assistant") continue;
      const msg = payload.message as Record<string, unknown> | undefined;
      const content = (msg ? msg.content : payload.content) as
        | Array<Record<string, unknown>>
        | undefined;
      if (!Array.isArray(content)) continue;
      const parts = content
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string);
      if (parts.length > 0) lastTextParts = parts;
    } catch {
      // skip unparseable events
    }
  }

  const combined = lastTextParts.join("").trim();
  if (!combined) return null;

  const candidate = extractJsonCandidate(combined);
  if (!candidate) return null;

  try {
    const parsed = JSON.parse(candidate) as Record<string, unknown>;
    if (
      typeof parsed.verdict === "string" &&
      Array.isArray(parsed.dimensions) &&
      typeof parsed.summary === "string"
    ) {
      return {
        verdict: parsed.verdict as ReviewResult["verdict"],
        dimensions: parsed.dimensions as ReviewDimension[],
        summary: parsed.summary,
      };
    }
  } catch {
    // not a verdict JSON block
  }

  return null;
}

// ── Verdict helpers ───────────────────────────────────────────────

const VERDICT_LABELS: Record<ReviewResult["verdict"], string> = {
  approved: "Approved",
  needs_changes: "Needs Changes",
  incomplete: "Incomplete",
  error: "Error",
};

const VERDICT_ICONS: Record<ReviewResult["verdict"], string> = {
  approved: "✓",
  needs_changes: "⚠",
  incomplete: "✕",
  error: "✕",
};

const VERDICT_STYLE_KEYS: Record<ReviewResult["verdict"], string> = {
  approved: "verdict--approved",
  needs_changes: "verdict--needs-changes",
  incomplete: "verdict--incomplete",
  error: "verdict--error",
};

// ── Component ─────────────────────────────────────────────────────

interface Props {
  session: SessionState;
}

export function ReviewDetailView({ session }: Props) {
  const result = parseReviewResultFromEvents(session.events);
  const isActive =
    session.status === "running" || session.status === "needs_permission";

  return (
    <div className={styles.reviewBody}>
      {/* ── Verdict + dimensions + summary ── */}
      <div className={styles.verdictSection}>
        {result ? (
          <>
            <div
              className={`${styles.verdictBadge} ${styles[VERDICT_STYLE_KEYS[result.verdict]]}`}
            >
              <span className={styles.verdictIcon}>
                {VERDICT_ICONS[result.verdict]}
              </span>
              {VERDICT_LABELS[result.verdict]}
            </div>

            {result.verdict !== "error" && result.dimensions.length > 0 && (
              <div className={styles.dimensions}>
                {result.dimensions.map((dim, i) => (
                  <div key={i} className={styles.dimension}>
                    <span
                      className={`${styles.dimIcon} ${dim.passed ? styles["dimIcon--pass"] : styles["dimIcon--fail"]}`}
                    >
                      {dim.passed ? "✓" : "✕"}
                    </span>
                    <div className={styles.dimContent}>
                      <span className={styles.dimName}>{dim.name}</span>
                      {dim.notes && (
                        <span className={styles.dimNotes}>{dim.notes}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {result.summary && (
              <p
                className={`${styles.summary} ${result.verdict === "error" ? styles["summary--error"] : ""}`}
              >
                {result.summary}
              </p>
            )}
          </>
        ) : isActive ? (
          <>
            <div
              className={`${styles.verdictBadge} ${styles["verdict--pending"]}`}
            >
              Review in progress…
            </div>
            <p className={styles.pendingHint}>
              Verdict will appear here when the review session completes.
            </p>
          </>
        ) : (
          <>
            <div
              className={`${styles.verdictBadge} ${styles["verdict--pending"]}`}
            >
              No result
            </div>
            <p className={styles.pendingHint}>
              No review verdict was found in this session's output.
            </p>
          </>
        )}
      </div>

      {/* ── Links: PR + code session ── */}
      {(session.prUrl || session.codeSessionId) && (
        <div className={styles.links}>
          {session.prUrl && (
            <a
              href={session.prUrl}
              target="_blank"
              rel="noreferrer"
              className={styles.prLink}
            >
              View PR{session.prNumber ? ` #${session.prNumber}` : ""} on GitHub
              ↗
            </a>
          )}
          {session.codeSessionId && (
            <button
              type="button"
              className={styles.codeSessionLink}
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent("selectSession", {
                    detail: { sessionId: session.codeSessionId },
                  }),
                )
              }
            >
              View code session ↗
            </button>
          )}
        </div>
      )}
    </div>
  );
}
