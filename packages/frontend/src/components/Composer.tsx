import { useState, useRef } from 'react';
import type { ClientMessage } from '@claude-orchestrator/backend/src/ws/types';
import styles from './Composer.module.css';

interface Props {
  sessionId: string;
  send: (msg: ClientMessage) => void;
}

export function Composer({ sessionId, send }: Props) {
  const [draft, setDraft] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function handleSend() {
    if (!draft.trim()) return;
    send({ type: 'send_message', sessionId, message: draft });
    setDraft('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }

  return (
    <div className={styles.composer}>
      <textarea
        ref={textareaRef}
        className={styles.composerInput}
        value={draft}
        rows={1}
        onChange={(e) => {
          setDraft(e.target.value);
          e.target.style.height = 'auto';
          e.target.style.height = `${e.target.scrollHeight}px`;
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && draft.trim()) {
            e.preventDefault();
            handleSend();
          }
        }}
        placeholder="Send a message to the session…"
      />
      <button
        className={styles.sendButton}
        onClick={handleSend}
        disabled={!draft.trim()}
      >
        Send
      </button>
    </div>
  );
}
