import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { ExecutableVersion } from '../../shared/types';
import { versionWarning } from '../../shared/executable';
import { api, errorMessage, jsonBody } from '../api';

export function ExecutableVersionCheck({ path, expected, disabled, onChecked }: {
  path: string; expected?: string; disabled?: boolean; onChecked: (result: ExecutableVersion) => void;
}) {
  const [result, setResult] = useState<ExecutableVersion | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    setChecking(false);
    setError('');
    return () => controller.current?.abort();
  }, [path]);
  const current = result?.executablePath === path ? result : null;
  const warning = current ? versionWarning(expected, current.version) : undefined;
  const check = async () => {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setChecking(true);
    setError('');
    setResult(null);
    try {
      const version = await api<ExecutableVersion>('/version', { ...jsonBody({ executablePath: path }), signal: request.signal });
      if (request.signal.aborted) return;
      setResult(version);
      onChecked(version);
    } catch (failure) {
      if (!request.signal.aborted) setError(errorMessage(failure));
    } finally {
      if (!request.signal.aborted) setChecking(false);
    }
  };
  return <div className="executable-version-check">
    <button type="button" className="button secondary" disabled={disabled || checking || !path.trim()} onClick={() => void check()}>
      <RefreshCw size={14} className={checking ? 'spin' : ''} />{checking ? 'Checking version...' : 'Check version'}
    </button>
    {current && <p className="field-help" role="status">Version: <strong>{current.version}</strong></p>}
    {expected && !current && <p className="field-help">Configuration version: {expected}. Check this executable to compare.</p>}
    {warning && <p className="support-warning" role="status">{warning}</p>}
    {error && <p className="field-error" role="alert">{error}</p>}
  </div>;
}
