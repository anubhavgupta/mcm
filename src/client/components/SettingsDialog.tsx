import { useEffect, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { FolderSearch, LockKeyhole, RefreshCw, Save } from 'lucide-react';
import { repoSchema } from '../../shared/config';
import type { LocalSettings, ModelFile, PublicSettings, Workspace } from '../../shared/types';
import { api, errorMessage } from '../api';
import { Dialog } from './Dialog';
import { useUnsavedWarning } from '../hooks/useUnsavedWarning';

interface SettingsValues extends LocalSettings { clearHfToken: boolean }

export function SettingsDialog({ settings, workspace, onClose, onSave, busy }: {
  settings: PublicSettings; workspace: Workspace; onClose: () => void;
  onSave: (values: SettingsValues) => Promise<void>; busy: boolean;
}) {
  const form = useForm<SettingsValues>({
    defaultValues: {
      executablePath: settings.executablePath, modelsDirectory: settings.modelsDirectory,
      serverPort: settings.serverPort, upstreamUrl: settings.upstreamUrl,
      modelBindings: { ...Object.fromEntries(workspace.models.map(model => [model.id, ''])), ...settings.modelBindings }, hfRepo: settings.hfRepo, hfToken: '', clearHfToken: false,
    },
  });
  useUnsavedWarning(form.formState.isDirty);
  const clearToken = useWatch({ control: form.control, name: 'clearHfToken' });
  const [files, setFiles] = useState<ModelFile[]>([]);
  const [discovery, setDiscovery] = useState<{ loading: boolean; error: string }>({ loading: true, error: '' });
  const loadModels = async () => {
    setDiscovery({ loading: true, error: '' });
    try {
      const result = await api<{ models: ModelFile[] }>('/models');
      setFiles(result.models);
      setDiscovery({ loading: false, error: '' });
    } catch (error) { setDiscovery({ loading: false, error: errorMessage(error) }); }
  };
  useEffect(() => { void loadModels(); }, []);
  const close = () => {
    if (!busy && (!form.formState.isDirty || window.confirm('Discard unsaved machine settings?'))) onClose();
  };
  return <Dialog title="Machine settings" subtitle="Local to this machine. Never included in a shared workspace." onClose={close} wide>
    <form className="dialog-form" onSubmit={form.handleSubmit(onSave)} noValidate>
      <div className="settings-form-grid">
        <div className="form-field full-width"><label htmlFor="executable-path">llama-server executable path</label><input id="executable-path" placeholder="/path/to/llama-server" {...form.register('executablePath')} /><p className="field-help">The server executable, not the containing folder. Changes apply on the next launch.</p></div>
        <div className="form-field full-width"><label htmlFor="models-directory">Models directory</label><input id="models-directory" placeholder="/path/to/models" {...form.register('modelsDirectory')} /><p className="field-help">Save this directory before refreshing discovered files.</p></div>
        <div className="form-field"><label htmlFor="server-port">Server port</label><input id="server-port" type="number" {...form.register('serverPort', { valueAsNumber: true, min: { value: 1, message: 'Use a port between 1 and 65535.' }, max: { value: 65535, message: 'Use a port between 1 and 65535.' }, validate: value => Number.isInteger(value) || 'Enter a whole-number port.' })} aria-invalid={!!form.formState.errors.serverPort} />
          {form.formState.errors.serverPort && <p role="alert" className="field-error">{form.formState.errors.serverPort.message}</p>}</div>
        <div className="form-field"><label htmlFor="upstream-url">Upstream URL <span aria-hidden="true">optional</span></label><input id="upstream-url" placeholder="http://127.0.0.1:8080" {...form.register('upstreamUrl', { validate: value => {
          if (!value) return true;
          try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) || 'Use an HTTP or HTTPS URL.'; } catch { return 'Enter a valid URL.'; }
        } })} aria-invalid={!!form.formState.errors.upstreamUrl} />{form.formState.errors.upstreamUrl && <p role="alert" className="field-error">{form.formState.errors.upstreamUrl.message}</p>}</div>
      </div>
      <div className="form-divider"><div><FolderSearch size={17} /><h3>Local model bindings</h3></div><button type="button" className="text-button" onClick={() => void loadModels()} disabled={discovery.loading}><RefreshCw size={14} className={discovery.loading ? 'spin' : ''} />Refresh models</button></div>
      <p className="field-help">Choose a discovered file for each portable model. Automatic matching uses its GGUF filename.</p>
      {discovery.error && <p className="inline-error" role="alert">{discovery.error}</p>}
      {!workspace.models.length && <p className="empty-inline">Create a model configuration to bind a local file.</p>}
      {workspace.models.map(model => {
        const currentBinding = settings.modelBindings[model.id];
        return <div className="form-field" key={model.id}><label htmlFor={`binding-${model.id}`}>Local file for {model.name}</label>
          <select id={`binding-${model.id}`} {...form.register(`modelBindings.${model.id}`)}>
            <option value="">Automatic — {model.model.filename}</option>
            {currentBinding && !files.some(file => file.relativePath === currentBinding) && <option value={currentBinding}>{currentBinding} (not in discovery)</option>}
            {files.map(file => <option key={file.relativePath} value={file.relativePath}>{file.relativePath} · {(file.size / 1024 ** 3).toFixed(2)} GB</option>)}
          </select>
        </div>;
      })}
      <div className="form-divider"><div><LockKeyhole size={17} /><h3>Hugging Face credentials</h3></div><span className="subtle-badge">Machine only</span></div>
      <div className="form-field"><label htmlFor="settings-hf-repo">Default dataset repository <span aria-hidden="true">optional</span></label><input id="settings-hf-repo" placeholder="owner/existing-dataset" {...form.register('hfRepo', { validate: value => !value || repoSchema.safeParse(value).success || 'Use owner/repository.' })} />
        {form.formState.errors.hfRepo && <p className="field-error" role="alert">{form.formState.errors.hfRepo.message}</p>}</div>
      <div className="form-field"><label htmlFor="hf-token">Hugging Face token</label><input id="hf-token" type="password" autoComplete="new-password" placeholder={settings.hfTokenConfigured ? 'Token configured — leave blank to keep' : 'hf_…'} {...form.register('hfToken')} disabled={clearToken} /><p className="field-help">{settings.hfTokenConfigured ? 'A token is stored securely on this machine. Its value is never sent to this browser.' : 'No token configured. A write token is required to push to your dataset repository.'} Blank preserves the stored token.</p></div>
      <label className="checkbox-label"><input type="checkbox" {...form.register('clearHfToken')} />Clear stored Hugging Face token</label>
      <div className="dialog-actions"><span className="field-help">{form.formState.isDirty ? 'Unsaved settings' : 'Machine-local preferences'}</span><div className="action-spacer" /><button className="button ghost" type="button" onClick={close} disabled={busy}>Cancel</button><button className="button primary" type="submit" disabled={busy}><Save size={15} />{busy ? 'Saving…' : 'Save settings'}</button></div>
    </form>
  </Dialog>;
}
