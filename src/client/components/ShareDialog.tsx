import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { ArrowDownToLine, ArrowUpFromLine, Check, Copy, ExternalLink, FileJson, Globe, Link2 } from 'lucide-react';
import { repoSchema, workspaceSchema } from '../../shared/config';
import { createShareUrl, modelWorkspace } from '../../shared/sharing';
import type { Workspace } from '../../shared/types';
import { api, errorMessage, jsonBody } from '../api';
import { Dialog } from './Dialog';

export function validateWorkspace(value: unknown): Workspace {
  const result = workspaceSchema.safeParse(value);
  if (!result.success) throw new Error(result.error.issues.slice(0, 5).map(issue => `${issue.path.join('.') || 'Workspace'}: ${issue.message}`).join('\n'));
  return result.data;
}

interface ShareValues { scope: 'model' | 'workspace'; repo: string; link: string; upload: FileList; uploadedUrl: string; hfLink: string }

export function ShareDialog({ workspace, selectedModelId, repo, onClose, onImport, notify }: {
  workspace: Workspace; selectedModelId?: string; repo: string; onClose: () => void;
  onImport: (workspace: Workspace, source: string) => void; notify: (message: string, error?: boolean) => void;
}) {
  const form = useForm<ShareValues>({ defaultValues: { scope: selectedModelId ? 'model' : 'workspace', repo, link: '', uploadedUrl: '', hfLink: '' } });
  const scope = form.watch('scope');
  const shared = scope === 'model' && selectedModelId ? modelWorkspace(workspace, selectedModelId) : workspace;
  let link = '';
  let linkError = '';
  try { link = createShareUrl(shared, window.location.origin); } catch (error) { linkError = errorMessage(error); }
  const [busy, setBusy] = useState<'push' | 'pull' | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    form.setValue('link', link);
    setCopied(false);
  }, [link, form]);
  const uploadedUrl = form.watch('uploadedUrl');
  const hfLink = form.watch('hfLink');
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      notify('Link copied to clipboard.');
    } catch {
      form.setFocus(text === hfLink && hfLink ? 'hfLink' : 'link', { shouldSelect: true });
      notify('Automatic copying is unavailable. The link is selected; press Ctrl+C (or ⌘C) to copy it manually.', true);
    }
  };
  const hfAction = (action: 'push' | 'pull') => form.handleSubmit(async values => {
    if (action === 'push' && !window.confirm(`Upload ${values.scope === 'model' ? 'the selected model and its inherited settings' : 'all saved configurations'} to this existing dataset repository? This replaces mcm/workspace.json in the repository.`)) return;
    setBusy(action);
    try {
      if (action === 'push') {
        const result = await api<{ url: string }>('/hf/push', jsonBody({ repo: values.repo, ...(values.scope === 'model' && selectedModelId ? { modelId: selectedModelId } : {}) }));
        form.setValue('uploadedUrl', result.url);
        const url = new URL(window.location.origin);
        url.hash = `hf=${values.repo}`;
        form.setValue('hfLink', url.toString());
        notify('Workspace uploaded to Hugging Face.');
      } else {
        const result = await api<{ workspace: unknown }>('/hf/pull', jsonBody({ repo: values.repo }));
        onImport(validateWorkspace(result.workspace), `Hugging Face · ${values.repo}`);
      }
    } catch (error) { notify(errorMessage(error), true); } finally { setBusy(null); }
  });
  const download = () => {
    const blob = new Blob([JSON.stringify(workspaceSchema.parse(shared), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = 'mcm-workspace.json'; anchor.click();
    URL.revokeObjectURL(url);
    notify('Workspace JSON downloaded.');
  };
  return <Dialog title="Share configurations" subtitle="Choose what to share. Machine paths and credentials stay private." onClose={() => { if (!busy) onClose(); }} wide>
    <div className="share-summary"><div><strong>{shared.models.length}</strong><span>Models</span></div><div><strong>{shared.groups.length}</strong><span>Groups</span></div><div><strong>{Object.keys(shared.base).length}</strong><span>Base overrides</span></div><span className="subtle-badge"><Globe size={12} />Portable by design</span></div>
    <form className="dialog-form" onSubmit={event => event.preventDefault()}>
      <div className="form-field"><label htmlFor="share-scope">Share scope</label><select id="share-scope" disabled={!!busy} {...form.register('scope')}>
        <option value="model" disabled={!selectedModelId}>Selected model only</option>
        <option value="workspace">All model configurations</option>
      </select><p className="field-help">{selectedModelId ? 'Selected model exports include its base settings and assigned group. This scope applies to links, JSON and Hugging Face uploads.' : 'Select a model in the sidebar to share only that model. Currently sharing all configurations.'}</p></div>
      <section className="share-section"><h3><Link2 size={18} />Configuration link</h3><p className="field-help">A snapshot of the selected scope. Anyone with this link can review and import it.</p>
        {linkError ? <p className="inline-error" role="alert">{linkError}</p> : <div className="copy-row"><label className="sr-only" htmlFor="share-link">Workspace share link</label><input id="share-link" readOnly {...form.register('link')} /><button type="button" className="button secondary" onClick={() => void copy(link)}>{copied ? <Check size={15} /> : <Copy size={15} />}Copy link</button></div>}
      </section>
      <section className="share-section"><h3><FileJson size={18} />Take it with you</h3><p className="field-help">Keep a JSON backup or review a workspace from another machine.</p><div className="file-actions"><button type="button" className="button secondary" onClick={download}><ArrowDownToLine size={15} />Download JSON</button><label className="button secondary upload-button"><ArrowUpFromLine size={15} />Import JSON<input type="file" accept=".json,application/json" aria-label="Import workspace JSON" {...form.register('upload', { onChange: async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;
        try {
          if (file.size > 2_000_000) throw new Error('The JSON file is too large (maximum 2 MB).');
          const value: unknown = JSON.parse(await file.text());
          onImport(validateWorkspace(value), file.name);
        } catch (error) { notify(errorMessage(error), true); }
        event.target.value = '';
      } })} /></label></div></section>
      <section className="share-section"><div className="share-section-heading"><h3><span className="hf-icon" aria-hidden="true">🤗</span>Hugging Face</h3><span className="subtle-badge">Existing dataset repository</span></div>
        <p className="field-help">Push replaces <code>mcm/workspace.json</code>. Pull only previews; you choose whether to import. Configure your token in Machine settings.</p>
        <div className="form-field"><label htmlFor="share-repo">Dataset repository</label><input id="share-repo" placeholder="owner/existing-dataset" {...form.register('repo', { validate: value => repoSchema.safeParse(value).success || 'Enter a dataset repository as owner/repository.' })} aria-invalid={!!form.formState.errors.repo} />{form.formState.errors.repo && <p role="alert" className="field-error">{form.formState.errors.repo.message}</p>}</div>
        <div className="file-actions"><button type="button" className="button secondary" disabled={!!busy} onClick={() => void hfAction('push')()}><ArrowUpFromLine size={15} />{busy === 'push' ? 'Uploading…' : 'Push workspace'}</button><button type="button" className="button ghost" disabled={!!busy} onClick={() => void hfAction('pull')()}><ArrowDownToLine size={15} />{busy === 'pull' ? 'Fetching preview…' : 'Preview pull'}</button></div>
        {uploadedUrl && <div className="upload-result"><label htmlFor="uploaded-url">Uploaded file URL</label><input id="uploaded-url" readOnly {...form.register('uploadedUrl')} /><a href={uploadedUrl} target="_blank" rel="noreferrer">View uploaded workspace <ExternalLink size={13} /></a><label htmlFor="hf-share-link">MCM Hugging Face share link</label><div className="copy-row"><input id="hf-share-link" readOnly {...form.register('hfLink')} /><button type="button" className="button secondary" onClick={() => void copy(hfLink)} aria-label="Copy Hugging Face share link"><Copy size={15} /></button></div></div>}
      </section>
      <div className="dialog-actions"><p className="field-help"><Check size={13} /> Local file bindings and tokens stay private.</p><div className="action-spacer" /><button type="button" className="button ghost" disabled={!!busy} onClick={onClose}>Done</button></div>
    </form>
  </Dialog>;
}
