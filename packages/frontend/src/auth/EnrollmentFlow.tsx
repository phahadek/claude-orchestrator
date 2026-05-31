import { useState, useEffect, useCallback } from 'react';
import { setDeviceToken } from './deviceToken';

interface EnrollmentFlowProps {
  onEnrolled: () => void;
}

type Step = 'checking' | 'requesting' | 'waiting' | 'error';

async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return res.json() as Promise<T>;
}

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path);
  return res.json() as Promise<T>;
}

export function EnrollmentFlow({ onEnrolled }: EnrollmentFlowProps) {
  const [step, setStep] = useState<Step>('checking');
  const [code, setCode] = useState<string | null>(null);
  const [deviceName, setDeviceName] = useState('My Device');
  const [error, setError] = useState<string | null>(null);

  const doBootstrap = useCallback(async () => {
    try {
      const result = await apiPost<{ token?: string; error?: string }>(
        '/api/enrollment/bootstrap',
        { name: deviceName },
      );
      if (result.token) {
        setDeviceToken(result.token);
        onEnrolled();
      } else {
        // Devices already enrolled — go to pairing flow
        setStep('requesting');
      }
    } catch {
      setError('Failed to connect to the orchestrator.');
      setStep('error');
    }
  }, [deviceName, onEnrolled]);

  // On mount: check bootstrap mode
  useEffect(() => {
    void doBootstrap();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const requestCode = useCallback(async () => {
    try {
      const result = await apiPost<{ code?: string; error?: string }>(
        '/api/enrollment/request',
        { name: deviceName },
      );
      if (result.code) {
        setCode(result.code);
        setStep('waiting');
      } else {
        setError(result.error ?? 'Failed to request code');
        setStep('error');
      }
    } catch {
      setError('Failed to request enrollment code.');
      setStep('error');
    }
  }, [deviceName]);

  // Poll for approval while waiting
  useEffect(() => {
    if (step !== 'waiting' || !code) return;

    const interval = setInterval(async () => {
      try {
        const result = await apiGet<{
          status: string;
          token?: string;
        }>(`/api/enrollment/status?code=${encodeURIComponent(code)}`);

        if (result.status === 'approved' && result.token) {
          clearInterval(interval);
          setDeviceToken(result.token);
          onEnrolled();
        } else if (result.status === 'expired') {
          clearInterval(interval);
          setError('Enrollment code expired. Please try again.');
          setCode(null);
          setStep('requesting');
        }
      } catch {
        // ignore transient errors during polling
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [step, code, onEnrolled]);

  return (
    <div style={styles.overlay}>
      <div style={styles.card}>
        <h2 style={styles.title}>Device Authorization</h2>

        {step === 'checking' && (
          <p style={styles.text}>Checking enrollment status…</p>
        )}

        {step === 'requesting' && (
          <>
            <p style={styles.text}>
              This device needs to be authorized. Enter a name, then request a
              pairing code. Approve it from an already-enrolled device.
            </p>
            <input
              style={styles.input}
              value={deviceName}
              onChange={(e) => setDeviceName(e.target.value)}
              placeholder="Device name"
            />
            <button style={styles.btn} onClick={() => void requestCode()}>
              Request pairing code
            </button>
          </>
        )}

        {step === 'waiting' && code && (
          <>
            <p style={styles.text}>
              Your pairing code is shown below. Approve it from an
              already-enrolled device (Settings → Devices).
            </p>
            <div style={styles.code}>{code}</div>
            <p style={styles.hint}>
              Waiting for approval… (code expires in 5 minutes)
            </p>
            <button
              style={{ ...styles.btn, ...styles.btnSecondary }}
              onClick={() => {
                setCode(null);
                setStep('requesting');
              }}
            >
              Start over
            </button>
          </>
        )}

        {step === 'error' && (
          <>
            <p style={{ ...styles.text, color: '#ef4444' }}>{error}</p>
            <button
              style={styles.btn}
              onClick={() => {
                setError(null);
                setStep('requesting');
              }}
            >
              Try again
            </button>
          </>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.7)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 9999,
  },
  card: {
    background: '#1e1e2e',
    border: '1px solid #313244',
    borderRadius: 12,
    padding: '32px 40px',
    maxWidth: 420,
    width: '90%',
    textAlign: 'center',
  },
  title: {
    color: '#cdd6f4',
    margin: '0 0 16px',
    fontSize: 20,
    fontWeight: 600,
  },
  text: {
    color: '#a6adc8',
    marginBottom: 20,
    lineHeight: 1.5,
  },
  hint: {
    color: '#6c7086',
    fontSize: 13,
    margin: '12px 0 0',
  },
  input: {
    width: '100%',
    padding: '8px 12px',
    borderRadius: 6,
    border: '1px solid #45475a',
    background: '#181825',
    color: '#cdd6f4',
    marginBottom: 12,
    fontSize: 14,
    boxSizing: 'border-box',
  },
  btn: {
    background: '#89b4fa',
    color: '#1e1e2e',
    border: 'none',
    borderRadius: 6,
    padding: '10px 24px',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
    width: '100%',
  },
  btnSecondary: {
    background: 'transparent',
    color: '#89b4fa',
    border: '1px solid #89b4fa',
    marginTop: 8,
  },
  code: {
    fontFamily: 'monospace',
    fontSize: 36,
    fontWeight: 700,
    letterSpacing: '0.3em',
    color: '#a6e3a1',
    background: '#181825',
    border: '1px solid #313244',
    borderRadius: 8,
    padding: '16px 24px',
    margin: '0 auto 12px',
    display: 'inline-block',
  },
};
