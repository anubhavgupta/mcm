import { useEffect, useState } from 'react';
import { useManager } from '../hooks/useManager';
import { InferenceCard } from './InferenceCard';
import { applyTheme } from '../theme';
import { themeSchema } from '../../shared/themes';
import { errorMessage } from '../api';
import { InferenceWindowControls } from './InferenceWindowControls';

export function NativeInferencePage() {
  const manager = useManager();
  const [themeError, setThemeError] = useState('');
  const [windowError, setWindowError] = useState('');
  useEffect(() => {
    document.body.classList.add('runtime-pip-document');
    document.title = 'MCM Inference';
    return () => document.body.classList.remove('runtime-pip-document');
  }, []);
  useEffect(() => {
    if (manager.loading) return;
    let active = true;
    let revision = 0;
    const update = (value: unknown) => {
      const parsed = themeSchema.safeParse(value);
      if (parsed.success) { applyTheme(parsed.data); setThemeError(''); }
      else setThemeError('Desktop theme update was invalid.');
    };
    const receive = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      revision++;
      update(event.detail?.theme);
    };
    window.addEventListener('mcm-inference-theme', receive);
    const initial = revision;
    const getTheme = window.bindings?.mcmGetInferenceTheme;
    if (getTheme) {
      void getTheme().then(theme => {
        if (active && revision === initial) update(theme);
      }).catch(error => { if (active) setThemeError(errorMessage(error)); });
    }
    return () => { active = false; window.removeEventListener('mcm-inference-theme', receive); };
  }, [manager.loading]);
  return <main className="runtime-detached native-inference-page">
    <InferenceCard connected={manager.connected} throughput={manager.throughput} usage={manager.usage}
      control={<InferenceWindowControls onError={setWindowError} />} />
    {manager.error && <p className="inline-error" role="alert">{manager.error}</p>}
    {themeError && <p className="inline-error" role="alert">{themeError}</p>}
    {windowError && <p className="inline-error" role="alert">{windowError}</p>}
  </main>;
}
