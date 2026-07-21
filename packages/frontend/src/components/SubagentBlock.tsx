import { useState } from 'react';
import {
  tryParseJson,
  extractToolResult,
  extractCallInput,
} from '../utils/eventParsing';
import type { CallPair } from './ToolCallGroup';
import styles from './EventTranscript.module.css';

interface Props {
  toolName: string;
  calls: CallPair[];
}

const RESULT_PREVIEW_LINES = 20;

/** Renders a Task/Agent (subagent) invocation as a distinct, collapsible block. */
export function SubagentBlock({ toolName, calls }: Props) {
  const call = calls[0];
  const [open, setOpen] = useState(false);

  const input = extractCallInput(call.textEvent) as Record<
    string,
    unknown
  > | null;
  const description =
    typeof input?.description === 'string' ? input.description : null;
  const subagentType =
    typeof input?.subagent_type === 'string' ? input.subagent_type : null;
  const prompt = typeof input?.prompt === 'string' ? input.prompt : null;
  const label = description ?? subagentType ?? toolName;

  const resultPayload = tryParseJson(call.resultEvent.content);
  const rawResult = extractToolResult(resultPayload, call.resultEvent.content);
  const resultLines = rawResult.split('\n');
  const truncated = resultLines.length > RESULT_PREVIEW_LINES;
  const resultPreview = truncated
    ? resultLines.slice(0, RESULT_PREVIEW_LINES).join('\n') +
      `\n… (+${resultLines.length - RESULT_PREVIEW_LINES} lines)`
    : rawResult;

  function toggle() {
    setOpen((o) => !o);
  }

  return (
    <div className={styles.subagentBlock}>
      <div
        className={styles.subagentHeader}
        role="button"
        tabIndex={0}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') toggle();
        }}
        aria-expanded={open}
      >
        <span className={styles.toolChevron}>{open ? '▼' : '▶'}</span>
        <span className={styles.subagentIcon}>🤖</span>
        <span className={styles.subagentLabel}>Subagent: {label}</span>
        {subagentType && description && (
          <span className={styles.subagentDetail}>({subagentType})</span>
        )}
      </div>
      {open && (
        <div className={styles.subagentBody}>
          {prompt && <pre className={styles.subagentPrompt}>{prompt}</pre>}
          {resultPreview.trim() && (
            <pre className={styles.subagentResult}>{resultPreview}</pre>
          )}
        </div>
      )}
    </div>
  );
}
