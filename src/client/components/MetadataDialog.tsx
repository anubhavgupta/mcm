import { useEffect, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { Box, Folder, RefreshCw, Trash2 } from 'lucide-react';
import { repoSchema } from '../../shared/config';
import type { ConfigGroup, ModelConfig, ModelFile, Workspace } from '../../shared/types';
import { api, errorMessage } from '../api';
import { Dialog } from './Dialog';
import { useUnsavedWarning } from '../hooks/useUnsavedWarning';

interface MetadataValues {
  name: string; filename: string; repo: string; groupId: string;
}
export type MetadataTarget = { kind: 'group'; item?: ConfigGroup } | { kind: 'model'; item?: ModelConfig };

export function MetadataDialog({ target, workspace, onClose, onSave, onDelete, busy }: {
  target: MetadataTarget; workspace: Workspace; onClose: () => void;
  onSave: (target: MetadataTarget, values: MetadataValues) => Promise<void>;
  onDelete: (target: MetadataTarget) => Promise<void>; busy: boolean;
}) {
  const isModel = target.kind === 'model';
  const model = target.kind === 'model' ? target.item : undefined;
  const form = useForm<MetadataValues>({
    defaultValues: {
      name: target.item?.name ?? '', filename: model?.model.filename ?? '', repo: model?.model.repo ?? '', groupId: model?.groupId ?? '',
    },
  });
  const selectedFilename = useWatch({ control: form.control, name: 'filename' });
  const [files, setFiles] = useState<ModelFile[]>([]);
  const [discovery, setDiscovery] = useState({ loading: isModel, error: '' });
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!isModel) return;
    const controller = new AbortController();
    setDiscovery({ loading: true, error: '' });
    void api<{ models: ModelFile[] }>('/models', { signal: controller.signal }).then(result => {
      setFiles(result.models);
      setDiscovery({ loading: false, error: '' });
    }).catch(error => {
      if (!controller.signal.aborted) setDiscovery({ loading: false, error: errorMessage(error) });
    });
    return () => controller.abort();
  }, [isModel, refresh]);
  const filenames = [...new Set(files.map(file => file.filename))];
  useUnsavedWarning(form.formState.isDirty);
  const close = () => {
    if (busy) return;
    if (!form.formState.isDirty || window.confirm('Discard unsaved details?')) onClose();
  };
  return <Dialog title={`${target.item ? 'Edit' : 'New'} ${target.kind}`} subtitle={isModel ? 'A portable identity. Your local file stays on this machine.' : 'Give related models a shared starting point.'} onClose={close}>
    <form onSubmit={form.handleSubmit(values => onSave(target, values))} className="dialog-form" noValidate>
      {isModel && <>
        <div className="form-field"><label htmlFor="model-filename">GGUF model</label><select id="model-filename" value={selectedFilename} disabled={discovery.loading || busy} {...form.register('filename', {
          required: 'Select a GGUF model.',
          maxLength: { value: 255, message: 'Use 255 characters or fewer.' },
          pattern: { value: /^[^/\\:\x00-\x1f]+\.gguf$/i, message: 'Select a portable GGUF filename.' },
          onChange: (event: React.ChangeEvent<HTMLSelectElement>) => {
            const filename = event.target.value;
            if (!form.getValues('name').trim() || (!target.item && !form.getFieldState('name').isDirty)) {
              form.setValue('name', filename.replace(/\.gguf$/i, ''), { shouldValidate: true });
            }
          },
        })} aria-invalid={!!form.formState.errors.filename}>
          <option value="">{discovery.loading ? 'Loading models...' : 'Select a model'}</option>
          {model && !filenames.includes(model.model.filename) && <option value={model.model.filename}>{model.model.filename} (not in discovery)</option>}
          {filenames.map(filename => <option key={filename} value={filename}>{filename}</option>)}
        </select>
          <button type="button" className="text-button" disabled={discovery.loading || busy} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={14} />Refresh models</button>
          {discovery.error && <p className="inline-error" role="alert">{discovery.error} Configure the models directory in Machine settings, then refresh.</p>}
          {!discovery.loading && !discovery.error && files.length === 0 && <p className="field-help">No GGUF models found. Set your models directory in Machine settings or add GGUF files, then refresh.</p>}
          <p className="field-help">Models come from your saved models directory. If multiple files share a filename, choose the exact local file in Machine settings.</p>
          {form.formState.errors.filename && <p className="field-error" role="alert">{form.formState.errors.filename.message}</p>}</div>
      </>}
      <div className="form-field"><label htmlFor="entity-name">{isModel ? 'Model name' : 'Group name'}</label><input id="entity-name" autoFocus={!isModel} placeholder={isModel ? 'e.g. My coding model' : 'e.g. Creative writing'} {...form.register('name', { required: 'A name is required.', maxLength: { value: 120, message: 'Use 120 characters or fewer.' }, validate: value => !!value.trim() || 'A name is required.' })} aria-invalid={!!form.formState.errors.name} />
        {form.formState.errors.name && <p className="field-error" role="alert">{form.formState.errors.name.message}</p>}</div>
      {isModel && <>
        <div className="form-field"><label htmlFor="model-repo">Hugging Face model repository <span aria-hidden="true">optional</span></label><input id="model-repo" placeholder="owner/model-GGUF" {...form.register('repo', { validate: value => !value || repoSchema.safeParse(value).success || 'Use owner/repository.' })} aria-invalid={!!form.formState.errors.repo} />
          {form.formState.errors.repo && <p className="field-error" role="alert">{form.formState.errors.repo.message}</p>}</div>
        <div className="form-field"><label htmlFor="model-group">Configuration group</label><select id="model-group" {...form.register('groupId')}><option value="">None — inherit directly from Base</option>{workspace.groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select></div>
      </>}
      <div className="info-box">{isModel ? <Box size={17} /> : <Folder size={17} />}<p>{isModel ? 'Model overrides take priority over group and base settings. No model is downloaded or launched when you save.' : 'Group overrides sit between Base and Model. Models can optionally join this group.'}</p></div>
      <div className="dialog-actions">
        {target.item && <button type="button" className="button danger-ghost" disabled={busy} onClick={() => {
          const message = target.kind === 'group' ? 'Delete this group? Its models will remain and inherit directly from Base. Group overrides will be removed.' : 'Delete this model configuration? This will not delete its GGUF file.';
          if (window.confirm(message)) void onDelete(target);
        }}><Trash2 size={15} />Delete {target.kind}</button>}
        <div className="action-spacer" /><button className="button ghost" type="button" onClick={close} disabled={busy}>Cancel</button><button className="button primary" type="submit" disabled={busy}>{busy ? 'Saving…' : target.item ? 'Save details' : `Create ${target.kind}`}</button>
      </div>
    </form>
  </Dialog>;
}
