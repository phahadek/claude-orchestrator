import { useState, useEffect, useCallback } from "react";
import styles from "./DiffViewer.module.css";

// ── Diff line classification ───────────────────────────────────────

export type DiffLineKind =
  | "added"
  | "removed"
  | "hunk"
  | "file-header"
  | "context";

export interface DiffLine {
  kind: DiffLineKind;
  content: string;
  lineNum: number;
}

export function classifyDiffLine(line: string): DiffLineKind {
  if (
    line.startsWith("diff --git") ||
    line.startsWith("--- ") ||
    line.startsWith("+++ ")
  ) {
    return "file-header";
  }
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "added";
  if (line.startsWith("-")) return "removed";
  return "context";
}

export function parseDiffLines(raw: string): DiffLine[] {
  return raw.split("\n").map((content, i) => ({
    kind: classifyDiffLine(content),
    content,
    lineNum: i + 1,
  }));
}

// ── Component ─────────────────────────────────────────────────────

interface Props {
  prNumber: number;
  projectId: string | null | undefined;
}

export function DiffViewer({ prNumber, projectId }: Props) {
  const [diff, setDiff] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchDiff = useCallback(async () => {
    if (!projectId) {
      setError("No project ID available");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/prs/${prNumber}/diff?projectId=${encodeURIComponent(projectId)}`,
      );
      if (!res.ok) {
        const body = (await res
          .json()
          .catch(() => ({ error: res.statusText }))) as { error?: string };
        setError(body.error ?? res.statusText);
        return;
      }
      const data = (await res.json()) as { diff: string };
      setDiff(data.diff);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [prNumber, projectId]);

  useEffect(() => {
    void fetchDiff();
  }, [fetchDiff]);

  const lines = diff != null ? parseDiffLines(diff) : [];

  return (
    <div className={styles.container}>
      <div className={styles.toolbar}>
        <button
          className={styles.refreshButton}
          onClick={() => void fetchDiff()}
          disabled={loading}
          title="Refresh diff"
        >
          {loading ? "…" : "↻"}
        </button>
      </div>

      {loading && (
        <div className={styles.skeleton}>
          {Array.from({ length: 12 }).map((_, i) => (
            <div
              key={i}
              className={styles.skeletonLine}
              style={{ width: `${55 + ((i * 37) % 45)}%` }}
            />
          ))}
        </div>
      )}

      {!loading && error != null && (
        <div className={styles.error}>Failed to load diff: {error}</div>
      )}

      {!loading && error == null && diff != null && lines.length === 0 && (
        <div className={styles.empty}>No changes in this diff.</div>
      )}

      {!loading && error == null && diff != null && lines.length > 0 && (
        <div className={styles.diff}>
          <table className={styles.diffTable}>
            <tbody>
              {lines.map((line) => (
                <tr
                  key={line.lineNum}
                  className={styles[`line${capitalize(line.kind)}`]}
                >
                  <td className={styles.lineNum}>{line.lineNum}</td>
                  <td className={styles.lineContent}>{line.content}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function capitalize(kind: DiffLineKind): string {
  switch (kind) {
    case "added":
      return "Added";
    case "removed":
      return "Removed";
    case "hunk":
      return "Hunk";
    case "file-header":
      return "FileHeader";
    case "context":
      return "Context";
  }
}
