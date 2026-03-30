import { useState, useEffect } from 'react';
import styles from './PermissionRules.module.css';

// Matches the db/types.ts PermissionRule shape returned by the REST API
interface PermissionRule {
  id: number;
  order_index: number;
  pattern: string;
  match_type: 'glob' | 'regex';
  decision: 'allow' | 'deny';
  label: string | null;
  enabled: number; // 0 | 1
}

async function fetchRules(): Promise<PermissionRule[]> {
  const res = await fetch('/api/rules');
  if (!res.ok) throw new Error(`Failed to fetch rules: ${res.status}`);
  return res.json() as Promise<PermissionRule[]>;
}

interface RuleRowProps {
  rule: PermissionRule;
  onChange: React.Dispatch<React.SetStateAction<PermissionRule[]>>;
}

function RuleRow({ rule, onChange }: RuleRowProps) {
  async function handleToggle() {
    const res = await fetch(`/api/rules/${rule.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: rule.enabled ? 0 : 1 }),
    });
    if (!res.ok) return;
    const updated: PermissionRule = await res.json();
    onChange((prev) => prev.map((r) => (r.id === rule.id ? updated : r)));
  }

  async function handleDelete() {
    if (!confirm(`Delete rule "${rule.pattern}"?`)) return;
    const res = await fetch(`/api/rules/${rule.id}`, { method: 'DELETE' });
    if (!res.ok) return;
    onChange((prev) => prev.filter((r) => r.id !== rule.id));
  }

  return (
    <tr className={rule.enabled ? '' : styles.disabled}>
      <td>{rule.order_index}</td>
      <td className={styles.patternCell}>{rule.pattern}</td>
      <td>{rule.match_type}</td>
      <td className={rule.decision === 'allow' ? styles.allow : styles.deny}>
        {rule.decision}
      </td>
      <td>{rule.label ?? '—'}</td>
      <td>
        <input
          type="checkbox"
          checked={rule.enabled === 1}
          onChange={handleToggle}
          aria-label="Enabled"
        />
      </td>
      <td>
        <button className={styles.deleteBtn} onClick={handleDelete} type="button">
          Delete
        </button>
      </td>
    </tr>
  );
}

interface AddRuleFormProps {
  onSave: (rule: PermissionRule) => void;
  onCancel: () => void;
}

function AddRuleForm({ onSave, onCancel }: AddRuleFormProps) {
  const [pattern, setPattern] = useState('');
  const [matchType, setMatchType] = useState<'glob' | 'regex'>('glob');
  const [decision, setDecision] = useState<'allow' | 'deny'>('allow');
  const [label, setLabel] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const res = await fetch('/api/rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pattern,
        match_type: matchType,
        decision,
        label: label.trim() || null,
      }),
    });
    if (!res.ok) return;
    const created: PermissionRule = await res.json();
    onSave(created);
  }

  return (
    <form onSubmit={handleSubmit} className={styles.addForm}>
      <input
        type="text"
        placeholder="Pattern"
        value={pattern}
        onChange={(e) => setPattern(e.target.value)}
        required
      />
      <select
        value={matchType}
        onChange={(e) => setMatchType(e.target.value as 'glob' | 'regex')}
      >
        <option value="glob">glob</option>
        <option value="regex">regex</option>
      </select>
      <select
        value={decision}
        onChange={(e) => setDecision(e.target.value as 'allow' | 'deny')}
      >
        <option value="allow">allow</option>
        <option value="deny">deny</option>
      </select>
      <input
        type="text"
        placeholder="Label (optional)"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
      />
      <button type="submit">Save</button>
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
    </form>
  );
}

export function PermissionRules() {
  const [rules, setRules] = useState<PermissionRule[]>([]);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    fetchRules().then(setRules).catch(console.error);
  }, []);

  // Only user-configurable rules are in the SQLite table.
  // Hard-coded deny/allow lists live in PermissionEngine and are never stored here.
  const patternRules = rules;

  return (
    <div className={styles.container}>
      <h2>Permission Rules</h2>
      <p>Hard-coded deny and allow lists are not shown. These are your custom pattern rules.</p>

      <table className={styles.table}>
        <thead>
          <tr>
            <th>#</th>
            <th>Pattern</th>
            <th>Type</th>
            <th>Decision</th>
            <th>Label</th>
            <th>Enabled</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {patternRules.map((rule) => (
            <RuleRow key={rule.id} rule={rule} onChange={setRules} />
          ))}
        </tbody>
      </table>

      {adding ? (
        <AddRuleForm
          onSave={(r) => {
            setRules((p) => [...p, r]);
            setAdding(false);
          }}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <button className={styles.addBtn} onClick={() => setAdding(true)} type="button">
          + Add rule
        </button>
      )}
    </div>
  );
}
