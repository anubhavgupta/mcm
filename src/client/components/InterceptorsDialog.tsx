import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { ArrowDown, ArrowUp, LockKeyhole, Plus, Save, Trash2 } from 'lucide-react';
import type { CustomInterceptorEntry, InterceptorPipeline, InterceptorPipelineUpdate } from '../../shared/types';
import { api, errorMessage } from '../api';
import { useUnsavedWarning } from '../hooks/useUnsavedWarning';
import { Dialog } from './Dialog';

interface AddValues { name: string; modulePath: string; trusted: boolean }
const defaults: AddValues = { name: '', modulePath: '', trusted: false };
const editable = (pipeline: InterceptorPipeline): CustomInterceptorEntry[] =>
  pipeline.entries.flatMap(entry => entry.source === 'local' ? [{ id: entry.id, name: entry.name, modulePath: entry.modulePath }] : []);

export function InterceptorsDialog({ onClose }: { onClose: () => void }) {
  const [saved, setSaved] = useState<InterceptorPipeline | null>(null);
  const [entries, setEntries] = useState<CustomInterceptorEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [attempt, setAttempt] = useState(0);
  const form = useForm<AddValues>({ defaultValues: defaults });
  const changed = saved !== null && JSON.stringify(entries) !== JSON.stringify(editable(saved));
  const dirty = changed || form.formState.isDirty;
  useUnsavedWarning(dirty);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    void api<InterceptorPipeline>('/interceptors').then(pipeline => {
      if (active) { setSaved(pipeline); setEntries(editable(pipeline)); }
    }).catch(reason => { if (active) setError(errorMessage(reason)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [attempt]);
  const close = () => {
    if (!saving && (!dirty || window.confirm('Discard unsaved interceptor changes?'))) onClose();
  };
  const move = (index: number, offset: number) => {
    setEntries(current => {
      const next = [...current];
      [next[index], next[index + offset]] = [next[index + offset]!, next[index]!];
      return next;
    });
    setMessage('');
  };
  const save = async () => {
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const update: InterceptorPipelineUpdate = { entries, trustedCodeAcknowledged: true };
      const pipeline = await api<InterceptorPipeline>('/interceptors', { method: 'PUT', body: JSON.stringify(update) });
      setSaved(pipeline);
      setEntries(editable(pipeline));
      setMessage('Interceptors saved. New requests use this sequence; in-flight requests keep their original sequence.');
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setSaving(false); }
  };
  return <Dialog title="Interceptors" subtitle="Manage the trusted local code that handles proxy requests. Never included in shared workspaces." onClose={close} wide>
    <div className="dialog-form">
      <p className="field-help">Interceptors run from top to bottom for each hook. Required telemetry runs first, followed by environment-configured modules, then your custom sequence.</p>
      {loading && <p role="status">Loading interceptors…</p>}
      {error && <p className="inline-error" role="alert">{error}</p>}
      {!loading && !saved && <button className="button secondary" onClick={() => setAttempt(value => value + 1)}>Retry loading interceptors</button>}
      {saved && <>
        <ol className="interceptor-list" aria-label="Interceptor sequence">
          {saved.entries.filter(entry => entry.locked).map(entry => <li key={entry.id} className="interceptor-entry">
            <div className="interceptor-details"><strong>{entry.name}</strong><p className="field-help">{entry.source === 'builtin'
              ? 'Real PP/TG throughput and persisted token/cost accounting. Always enabled; cannot be removed or reordered.'
              : 'Locked for compatibility. Unset MCM_INTERCEPTOR_MODULE (or change createApp options) and restart MCM to remove.'}</p></div>
            <span className="subtle-badge"><LockKeyhole size={13} />{entry.source === 'builtin' ? 'Required' : 'Environment'}</span>
          </li>)}
          {entries.map((entry, index) => <li key={entry.id} className="interceptor-entry">
            <div className="interceptor-details"><strong>{entry.name}</strong><code>{entry.modulePath}</code></div>
            <div className="interceptor-controls">
              <button className="icon-button" type="button" aria-label={`Move ${entry.name} up`} title="Move up" disabled={saving || index === 0} onClick={() => move(index, -1)}><ArrowUp size={17} /></button>
              <button className="icon-button" type="button" aria-label={`Move ${entry.name} down`} title="Move down" disabled={saving || index === entries.length - 1} onClick={() => move(index, 1)}><ArrowDown size={17} /></button>
              <button className="icon-button danger" type="button" aria-label={`Remove ${entry.name}`} title="Remove" disabled={saving} onClick={() => { setEntries(current => current.filter(item => item.id !== entry.id)); setMessage(''); }}><Trash2 size={17} /></button>
            </div>
          </li>)}
        </ol>
        {!entries.length && <p className="empty-inline">No custom interceptors. Required telemetry remains active.</p>}
        <div className="form-divider"><div><Plus size={17} /><h3>Add a trusted interceptor</h3></div><span className="subtle-badge">Machine only</span></div>
        <p className="field-help" id="interceptor-trust-help">Only use files you have reviewed and trust. Loading a module executes code with MCM’s permissions, including access to local files, credentials, and request data. Never add untrusted files. No uploads or remote URLs are supported. Restart MCM after editing module files.</p>
        <form onSubmit={form.handleSubmit(values => {
          if (entries.some(entry => entry.modulePath === values.modulePath)) {
            form.setError('modulePath', { message: 'This module is already in the sequence.' });
            return;
          }
          setEntries(current => [...current, { id: `custom-${crypto.randomUUID()}`, name: values.name.trim(), modulePath: values.modulePath }]);
          form.reset(defaults);
          setMessage('Added to the draft sequence. Save interceptors to load and activate the module.');
        })} noValidate>
          <fieldset className="interceptor-add-fields" disabled={saving || entries.length >= 32}>
            <legend className="sr-only">New interceptor</legend>
            <div className="form-field"><label htmlFor="interceptor-name">Friendly name</label>
              <input id="interceptor-name" maxLength={100} {...form.register('name', { validate: value => !!value.trim() || 'Enter a friendly name.' })} aria-invalid={!!form.formState.errors.name} />
              {form.formState.errors.name && <p className="field-error" role="alert">{form.formState.errors.name.message}</p>}
            </div>
            <div className="form-field"><label htmlFor="interceptor-path">Absolute local module path</label>
              <input id="interceptor-path" placeholder="/absolute/path/to/request-tag.ts" maxLength={4096} {...form.register('modulePath', {
                required: 'Enter an absolute local module path.',
                validate: value => (!/[\x00-\x1f\x7f]/.test(value) && /^(?:\/|[a-zA-Z]:[\\/]|\\\\)/.test(value)) || 'Use an absolute local file path, not a URL.',
              })} aria-invalid={!!form.formState.errors.modulePath} />
              {form.formState.errors.modulePath && <p className="field-error" role="alert">{form.formState.errors.modulePath.message}</p>}
              <p className="field-help">The path is on the machine running MCM. Export one interceptor or an array; array order is preserved within this entry.</p>
            </div>
            <label className="checkbox-label"><input type="checkbox" aria-describedby="interceptor-trust-help" {...form.register('trusted', { required: 'Confirm that you trust this code before adding it.' })} />I trust this module and allow it to execute with MCM’s permissions.</label>
            {form.formState.errors.trusted && <p className="field-error" role="alert">{form.formState.errors.trusted.message}</p>}
            <button type="submit" className="button secondary"><Plus size={15} />Add interceptor</button>
            {form.formState.isDirty && <button type="button" className="button ghost" onClick={() => form.reset(defaults)}>Clear add form</button>}
          </fieldset>
        </form>
        {entries.length >= 32 && <p className="field-help">Maximum 32 custom modules. Remove an entry before adding another.</p>}
      </>}
      {message && <p className="field-help" role="status">{message}</p>}
      <div className="dialog-actions">
        <span className="field-help">{form.formState.isDirty ? 'Finish adding the module before saving.' : changed ? 'Unsaved interceptor changes' : 'Machine-local pipeline'}</span>
        <div className="action-spacer" />
        <button type="button" className="button ghost" onClick={close} disabled={saving}>Close</button>
        <button type="button" className="button primary" onClick={() => void save()} disabled={!changed || saving || loading || form.formState.isDirty}><Save size={15} />{saving ? 'Saving…' : 'Save interceptors'}</button>
      </div>
    </div>
  </Dialog>;
}
