import { AlertTriangle, ArrowRight, Box, Folder, Layers3 } from 'lucide-react';
import type { Workspace } from '../../shared/types';
import { Dialog } from './Dialog';

export function ImportDialog({ workspace, current, source, onClose, onImport, busy }: {
  workspace: Workspace; current: Workspace; source: string;
  onClose: () => void; onImport: () => void; busy: boolean;
}) {
  return <Dialog title="Review workspace import" subtitle={source} onClose={() => { if (!busy) onClose(); }}>
    <div className="import-body"><div className="import-transfer"><span>Current workspace<br /><strong>{current.models.length} models · {current.groups.length} groups</strong></span><ArrowRight size={20} /><span>Incoming workspace<br /><strong>{workspace.models.length} models · {workspace.groups.length} groups</strong></span></div>
      <div className="import-list"><div><Layers3 size={16} /><span>Base configuration</span><small>{Object.keys(workspace.base).length} overrides</small></div>
        {workspace.groups.map(group => <div key={group.id}><Folder size={16} /><span>{group.name}</span><small>{Object.keys(group.values).length} overrides</small></div>)}
        {workspace.models.map(model => <div key={model.id}><Box size={16} /><span>{model.name}<small>{model.model.filename}</small></span><small>{Object.keys(model.values).length} overrides</small></div>)}
      </div>
      <div className="warning-box"><AlertTriangle size={19} /><div><strong>This replaces your entire workspace.</strong><p>Existing base settings, groups, and model configurations will be replaced. Machine paths, local bindings, and tokens stay unchanged. No model will be launched.</p></div></div>
      <div className="dialog-actions"><button type="button" className="button ghost" onClick={onClose} disabled={busy}>Cancel import</button><div className="action-spacer" /><button type="button" className="button primary" onClick={onImport} disabled={busy}>{busy ? 'Importing…' : 'Replace workspace'}</button></div>
    </div>
  </Dialog>;
}
