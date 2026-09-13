import { Box, ChevronLeft, Folder, Layers3, Plus, Settings2, Share2, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { Workspace } from '../../shared/types';

export type Selection = { kind: 'base' } | { kind: 'group' | 'model'; id: string };

export function Sidebar({ workspace, selection, select, open, close, collapsed, toggleCollapsed, create, settings, share }: {
  workspace: Workspace; selection: Selection; select: (value: Selection) => void;
  open: boolean; close: () => void; collapsed: boolean; toggleCollapsed: () => void;
  create: (kind: 'model' | 'group') => void; settings: () => void; share: () => void;
}) {
  const sidebar = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    const frame = window.requestAnimationFrame(() => sidebar.current?.querySelector<HTMLButtonElement>('[aria-label="Close sidebar"]')?.focus());
    return () => { window.cancelAnimationFrame(frame); if (previous instanceof HTMLElement) previous.focus(); };
  }, [open]);
  const modelButton = (model: Workspace['models'][number], nested = false) => (
    <button key={model.id} type="button" className={`nav-item ${nested ? 'nested' : ''} ${selection.kind === 'model' && selection.id === model.id ? 'selected' : ''}`}
      aria-current={selection.kind === 'model' && selection.id === model.id ? 'page' : undefined}
      onClick={() => select({ kind: 'model', id: model.id })} title={model.name}>
      <Box size={16} /><span>{model.name}</span>
    </button>
  );
  return <>
    {open && <button className="nav-scrim" aria-label="Close navigation" onClick={close} />}
    <aside ref={sidebar} className={`sidebar ${open ? 'mobile-open' : ''} ${collapsed ? 'collapsed' : ''}`} aria-label="Workspace navigation" onKeyDown={event => { if (event.key === 'Escape' && open) close(); }}>
      <div className="brand"><div className="brand-mark"><Layers3 size={23} /></div><div className="brand-text"><strong>mcm<span className="brand-dot">.</span></strong><span>MODEL CONFIG MANAGER</span></div>
        <button className="icon-button mobile-only" onClick={close} aria-label="Close sidebar"><X size={18} /></button>
        <button className="icon-button desktop-only collapse-button" onClick={toggleCollapsed} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}><ChevronLeft size={16} /></button>
      </div>
      <div className="nav-heading"><span>CONFIGURATIONS</span><span>{workspace.models.length}</span></div>
      <nav className="config-nav">
        <button type="button" className={`nav-item ${selection.kind === 'base' ? 'selected' : ''}`}
          aria-label="Base configuration"
          aria-current={selection.kind === 'base' ? 'page' : undefined} onClick={() => select({ kind: 'base' })} title="Base configuration">
          <Layers3 size={17} /><span>Base configuration</span><span className="nav-badge">BASE</span>
        </button>
        {workspace.groups.map(group => <div className="nav-group" key={group.id}>
          <button type="button" className={`nav-item ${selection.kind === 'group' && selection.id === group.id ? 'selected' : ''}`}
            aria-label={group.name}
            aria-current={selection.kind === 'group' && selection.id === group.id ? 'page' : undefined}
            onClick={() => select({ kind: 'group', id: group.id })} title={group.name}>
            <Folder size={17} /><span>{group.name}</span><span className="nav-count">{workspace.models.filter(model => model.groupId === group.id).length}</span>
          </button>
          {workspace.models.filter(model => model.groupId === group.id).map(model => modelButton(model, true))}
        </div>)}
        {workspace.models.filter(model => !model.groupId).map(model => modelButton(model))}
        {!workspace.models.length && <div className="sidebar-empty"><span>Your next model starts here.</span><small>Create a configuration to make it yours.</small></div>}
      </nav>
      <div className="nav-create">
        <button className="button secondary" onClick={() => create('model')} title="New model"><Plus size={16} /><span>New model</span></button>
        <button className="text-button" onClick={() => create('group')} title="New group"><Folder size={15} /><span>New group</span></button>
      </div>
      <div className="sidebar-footer">
        <button className="nav-item" onClick={share} title="Share workspace"><Share2 size={17} /><span>Share workspace</span></button>
        <button className="nav-item" onClick={settings} title="Machine settings"><Settings2 size={17} /><span>Machine settings</span></button>
        <div className="local-note"><span className="tiny-dot" />Local-first. Yours to configure.<small>MCM / 2.0</small></div>
      </div>
    </aside>
  </>;
}
