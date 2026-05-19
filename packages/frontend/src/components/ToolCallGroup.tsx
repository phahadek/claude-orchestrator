import { useState } from "react";
import {
  tryParseJson,
  extractBashCommand,
  extractToolDetail,
  extractToolResult,
} from "../utils/eventParsing";
import styles from "./ToolCallGroup.module.css";

export interface CallPair {
  textEvent: { eventType: string; content: string; timestamp: number };
  resultEvent: { eventType: string; content: string; timestamp: number };
}

interface Props {
  toolName: string;
  calls: CallPair[];
}

/** Extract the first tool_use block's input from a text/assistant event. */
function extractCallInput(textEvent: CallPair["textEvent"]): unknown {
  const payload = tryParseJson(textEvent.content);
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  const msg = p.message as Record<string, unknown> | undefined;
  const blocks = msg ? msg.content : p.content;
  if (!Array.isArray(blocks)) return null;
  for (const block of blocks) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b.type === "tool_use") {
      let input = b.input;
      if (typeof input === "string") {
        try {
          input = JSON.parse(input);
        } catch {
          /* leave as string */
        }
      }
      return input;
    }
  }
  return null;
}

/** Produce a short label for a call's input (first string value or JSON snippet). */
function inputLabel(toolName: string, input: unknown): string {
  if (toolName === "Bash") {
    const cmd = extractBashCommand(input);
    if (cmd != null) return `$ ${cmd}`;
  }
  if (typeof input === "object" && input !== null) {
    const vals = Object.values(input as Record<string, unknown>);
    if (vals.length > 0) {
      const v = String(vals[0]);
      return v.length > 60 ? v.slice(0, 60) + "…" : v;
    }
  }
  if (typeof input === "string") return input.slice(0, 60);
  return toolName;
}

export function ToolCallGroup({ toolName, calls }: Props) {
  const [expanded, setExpanded] = useState(false);

  const firstInput =
    calls.length > 0 ? extractCallInput(calls[0].textEvent) : null;
  const rawDetail =
    toolName === "Bash"
      ? (((firstInput as Record<string, unknown> | null)?.description as
          | string
          | undefined) ??
        extractBashCommand(firstInput)?.slice(0, 40) ??
        null)
      : extractToolDetail(toolName, firstInput);
  const headerSuffix = rawDetail
    ? ` (${rawDetail.length > 40 ? rawDetail.slice(0, 40) + "…" : rawDetail})`
    : "";

  function toggle() {
    setExpanded((e) => !e);
  }

  return (
    <div className={styles.group}>
      <div
        className={styles.groupHeader}
        role="button"
        tabIndex={0}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") toggle();
        }}
        aria-expanded={expanded}
      >
        <span className={styles.chevron}>{expanded ? "▼" : "▶"}</span>
        🔧 {toolName}
        {headerSuffix} ×{calls.length}
      </div>
      {expanded && (
        <div className={styles.groupBody}>
          {calls.map((call, i) => (
            <CallItem key={i} toolName={toolName} call={call} />
          ))}
        </div>
      )}
    </div>
  );
}

function CallItem({ toolName, call }: { toolName: string; call: CallPair }) {
  const [open, setOpen] = useState(false);
  const input = extractCallInput(call.textEvent);
  const label = inputLabel(toolName, input);

  const resultPayload = tryParseJson(call.resultEvent.content);
  const rawResult = extractToolResult(resultPayload, call.resultEvent.content);
  let result = rawResult;
  try {
    const parsed = JSON.parse(rawResult);
    if (typeof parsed === "object" && parsed !== null) {
      result = JSON.stringify(parsed, null, 2);
    }
  } catch {
    /* not JSON */
  }

  function toggle() {
    setOpen((o) => !o);
  }

  return (
    <div className={styles.callItem}>
      <div
        className={styles.callHeader}
        role="button"
        tabIndex={0}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") toggle();
        }}
        aria-expanded={open}
      >
        <span className={styles.callChevron}>{open ? "▼" : "▶"}</span>
        🔧 {label}
      </div>
      {open && (
        <div className={styles.callBody}>
          {toolName === "Bash" && extractBashCommand(input) != null ? (
            <pre className={styles.args}>$ {extractBashCommand(input)}</pre>
          ) : (
            <pre className={styles.args}>{JSON.stringify(input, null, 2)}</pre>
          )}
          {result.trim() && <pre className={styles.result}>{result}</pre>}
        </div>
      )}
    </div>
  );
}
