import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowRight, Box, Check, ChevronRight, Copy, Layers3, Menu, Pencil, Play, Plus, RefreshCw, RotateCw, Share2, Square, X } from 'lucide-react';
import type { Capabilities, PublicSettings, ServerStatus, Values, Workspace } from '../shared/types';
import { decodeWorkspace } from '../shared/sharing';
import { api, errorMessage, jsonBody } from './api';
import { useManager } from './hooks/useManager';
import { useUnsavedWarning } from './hooks/useUnsavedWarning';
import { ConfigEditor } from './components/ConfigEditor';
import { Dialog } from './components/Dialog';
import { ImportDialog } from './components/ImportDialog';
import { MetadataDialog, type MetadataTarget } from './components/MetadataDialog';
import { RuntimePanel } from './components/RuntimePanel';
import { SettingsDialog } from './components/SettingsDialog';
import { ShareDialog, validateWorkspace } from './components/ShareDialog';
import { Sidebar, type Selection } from './components/Sidebar';
import { FeedbackContext } from './components/Feedback';

type Modal = { kind: 'metadata'; target: MetadataTarget } | { kind: 'settings' } | { kind: 'share' }
  | { kind: 'import'; workspace: Workspace; source: string }
  | { kind: 'command'; executable: string; args: string[] } | null;

export default function App() {
  const manager = useManager();
  const [selection, setSelection] = useState<Selection>({ kind: 'base' });
  const [dirty, setDirty] = useState(false);
  const [editorVersion, setEditorVersion] = useState(0);
  const [modal, setModal] = useState<Modal>(null);
  const [busy, setBusy] = useState('');
  const [mobileNav, setMobileNav] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [notice, setNotice] = useState<{ message: string; error: boolean } | null>(null);
  const handledHash = useRef('');
  const notify = useCallback((message: string, error = false) => setNotice({ message, error }), []);

  useEffect(() => {
    if (!notice || notice.error) return;
    const timeout = window.setTimeout(() => setNotice(null), 5500);
    return () => window.clearTimeout(timeout);
  }, [notice]);
  useUnsavedWarning(dirty);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 760px)');
    const resize = () => { if (!media.matches) setMobileNav(false); };
    media.addEventListener('change', resize);
    return () => media.removeEventListener('change', resize);
  }, []);

  const guard = (action: () => void) => {
    if (busy) return;
    if (dirty && !window.confirm('You have unsaved changes. Discard them and continue? Preview and launch use the last saved configuration.')) return;
    if (dirty) { setDirty(false); setEditorVersion(version => version + 1); }
    action();
  };
  const run = async (operation: string, action: () => Promise<void>) => {
    setBusy(operation);
    try { await action(); } catch (error) { notify(errorMessage(error), true); } finally { setBusy(''); }
  };
  const persist = async (workspace: Workspace) => {
    const saved = await api<Workspace>('/workspace', { method: 'PUT', body: JSON.stringify(validateWorkspace(workspace)) });
    manager.setWorkspace(saved);
    setDirty(false);
    setEditorVersion(version => version + 1);
  };
  const clearHash = () => {
    handledHash.current = '';
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  };
  const closeModal = () => { if (modal?.kind === 'import') clearHash(); setModal(null); };

  useEffect(() => {
    if (!manager.data) return;
    const readHash = () => {
      if (busy || modal) return;
      const hash = window.location.hash;
      if (hash === handledHash.current || (!hash.startsWith('#config=') && !hash.startsWith('#hf='))) return;
      handledHash.current = hash;
      guard(() => {
        if (hash.startsWith('#config=')) {
          try { setModal({ kind: 'import', workspace: decodeWorkspace(hash.slice(8)), source: 'Shared configuration link' }); }
          catch (error) { notify(errorMessage(error), true); }
        } else {
          void run('hf-link', async () => {
            const repo = decodeURIComponent(hash.slice(4));
            const result = await api<{ workspace: unknown }>('/hf/pull', jsonBody({ repo }));
            setModal({ kind: 'import', workspace: validateWorkspace(result.workspace), source: `Hugging Face · ${repo}` });
          });
        }
      });
    };
    readHash();
    window.addEventListener('hashchange', readHash);
    return () => window.removeEventListener('hashchange', readHash);
  }, [manager.data !== null, dirty, busy, modal, notify]);

  if (!manager.data) return <main className="boot-screen"><div className="boot-card"><div className="brand-mark"><Layers3 size={29} /></div><p className="eyebrow">MODEL CONFIG MANAGER</p><h1>Your models.<br /><span>Your way.</span></h1>
    {manager.loading ? <p className="boot-status"><RefreshCw size={17} className="spin" />Connecting to your workspace…</p> : <><p className="inline-error" role="alert"><AlertCircle size={18} />{manager.error}</p><p className="muted">The manager is unreachable. Your workspace has not been replaced with an empty fallback.</p><button className="button primary" onClick={() => void manager.reload()}><RefreshCw size={16} />Retry connection</button></>}
  </div></main>;

  const { workspace, settings } = manager.data;
  const selectedModel = selection.kind === 'model' ? workspace.models.find(model => model.id === selection.id) : undefined;
  const selectedGroup = selection.kind === 'group' ? workspace.groups.find(group => group.id === selection.id) : undefined;
  const title = selection.kind === 'base' ? 'Base configuration' : selectedModel?.name ?? selectedGroup?.name ?? 'Configuration';
  const group = selectedModel?.groupId ? workspace.groups.find(item => item.id === selectedModel.groupId) : undefined;
  const phase = manager.status?.phase;
  const running = phase === 'ready' || phase === 'starting' || phase === 'stopping';
  const processBusy = phase === 'starting' || phase === 'stopping';
  const activeModel = workspace.models.find(model => model.id === manager.status?.modelId);

  const openCreate = (kind: 'model' | 'group') => guard(() => { setMobileNav(false); setModal({ kind: 'metadata', target: { kind } }); });
  const saveValues = async (values: Values) => run('save', async () => {
    const next: Workspace = selection.kind === 'base' ? { ...workspace, base: values }
      : selection.kind === 'group' ? { ...workspace, groups: workspace.groups.map(item => item.id === selection.id ? { ...item, values } : item) }
        : { ...workspace, models: workspace.models.map(item => item.id === selection.id ? { ...item, values } : item) };
    await persist(next);
    notify('Configuration saved.');
  });
  const preview = () => guard(() => {
    if (!selectedModel) return;
    void run('preview', async () => {
      const result = await api<{ executable: string; args: string[] }>('/preview', jsonBody({ modelId: selectedModel.id }));
      setModal({ kind: 'command', ...result });
    });
  });
  const processAction = (action: 'launch' | 'stop' | 'restart') => guard(() => void run(action, async () => {
    const status = await api<ServerStatus>(`/${action}`, jsonBody(action === 'launch' ? { modelId: selectedModel?.id } : {}));
    manager.setStatus(status);
    notify(action === 'stop' ? 'Stop requested.' : action === 'restart' ? 'Restart requested using saved configuration.' : 'Launch requested using saved configuration.');
  }));

  return <FeedbackContext.Provider value={{ notice, dismiss: () => setNotice(null) }}><div className={`app-shell ${collapsed ? 'nav-collapsed' : ''}`}>
    <a className="skip-link" href="#main-content">Skip to configuration</a>
    <Sidebar workspace={workspace} selection={selection} select={value => guard(() => { setSelection(value); setEditorVersion(version => version + 1); setMobileNav(false); window.scrollTo({ top: 0 }); })}
      open={mobileNav} close={() => setMobileNav(false)} collapsed={collapsed} toggleCollapsed={() => setCollapsed(value => !value)}
      create={openCreate} settings={() => guard(() => { setMobileNav(false); setModal({ kind: 'settings' }); })}
      share={() => guard(() => { setMobileNav(false); setModal({ kind: 'share' }); })} />
    <div className="workspace-shell" inert={mobileNav}>
      <header className="topbar"><div className="breadcrumb"><button className="icon-button mobile-only" aria-label="Open navigation" onClick={() => setMobileNav(true)}><Menu size={21} /></button><span>Workspace</span><ChevronRight size={13} /><strong>{selection.kind === 'base' ? 'Base' : title}</strong></div>
        <div className="topbar-right"><span className={`connection-state ${manager.connected ? 'connected' : ''}`}><span className="tiny-dot" />{manager.connected ? 'Manager connected' : 'Disconnected · reconnecting'}</span><span className="local-chip">LOCAL</span></div>
      </header>
      {!manager.connected && <div className="connection-banner" role="status"><RefreshCw size={15} />Event stream disconnected. Reconnecting automatically; process status is last known, not confirmed stopped.</div>}
      <main id="main-content" className="main-content">
        <div className="page-heading"><div><p className="eyebrow">{selection.kind === 'base' ? 'THE FOUNDATION' : selection.kind === 'group' ? 'SHARED STARTING POINT' : 'MODEL CONFIGURATION'}</p><h1>{title}</h1><p className="page-description">{selection.kind === 'base' ? 'Set the defaults. Let every model build on them.' : selection.kind === 'group' ? 'A common setup for models that work alike.' : 'Fine-tune this model without changing the rest.'}</p></div>
          <div className="heading-actions">{selection.kind !== 'base' && <button className="button ghost" onClick={() => guard(() => setModal({ kind: 'metadata', target: selectedModel ? { kind: 'model', item: selectedModel } : { kind: 'group', item: selectedGroup } }))} disabled={!!busy}><Pencil size={15} />Edit details</button>}
            <button className="button secondary" onClick={() => guard(() => setModal({ kind: 'share' }))} disabled={!!busy}><Share2 size={15} />Share</button>
          </div>
        </div>
        <section className="launch-strip" aria-label="Server controls"><div className="launch-status"><span className={`process-indicator ${phase ?? 'unknown'}`} /><div><strong>{manager.connected ? phase === 'ready' ? 'Server ready' : phase === 'starting' ? 'Server starting' : phase === 'stopping' ? 'Server stopping' : phase === 'failed' ? 'Server failed' : phase === 'stopped' ? 'Server stopped' : 'Awaiting server status' : `Last known: ${phase ?? 'unknown'}`}</strong><small>{activeModel && running ? activeModel.name : selectedModel ? selectedModel.model.filename : 'Select a model configuration to launch'}{manager.status?.pid && running ? ` · PID ${manager.status.pid}` : ''}</small></div></div>
          <div className="launch-actions"><button className="button ghost" aria-label="Restart server" title="Restart the active model with saved settings" disabled={!running || processBusy || !manager.connected || !!busy} onClick={() => processAction('restart')}><RotateCw size={15} /><span>Restart</span></button><button className="button secondary" aria-label="Stop server" disabled={!running || processBusy || !manager.connected || !!busy} onClick={() => processAction('stop')}><Square size={12} /><span>Stop</span></button><button className="button primary" aria-label="Launch model" disabled={!selectedModel || running || !manager.connected || !!busy} onClick={() => processAction('launch')}><Play size={14} fill="currentColor" /><span>{busy === 'launch' ? 'Launching…' : 'Launch model'}</span></button></div>
        </section>
        {selectedModel && <div className="model-identity"><Box size={15} /><code>{selectedModel.model.filename}</code>{selectedModel.model.repo && <span>{selectedModel.model.repo}</span>}<span className="identity-parent">Inherits from {group?.name ?? 'Base'}</span></div>}
        {!workspace.models.length && <section className="welcome-card"><div className="welcome-icon"><Box size={23} /></div><div><h2>A good model deserves a great setup.</h2><p>Start with your base defaults, then add your first model. Share the same setup anywhere.</p></div><button className="button secondary" onClick={() => openCreate('model')}><Plus size={15} />Create your first model<ArrowRight size={14} /></button></section>}
        <div className="content-grid"><ConfigEditor key={`${selection.kind}-${selection.kind === 'base' ? '' : selection.id}-${editorVersion}`} workspace={workspace} selection={selection} capabilities={capabilities} onDirty={setDirty} onSave={saveValues} busy={!!busy} />
          <RuntimePanel connected={manager.connected} status={manager.status} throughput={manager.throughput} logs={manager.logs} clearLogs={manager.clearLogs} notify={notify} preview={preview} canPreview={!!selectedModel} capabilities={capabilities} busy={!!busy}
            probe={() => guard(() => void run('probe', async () => { setCapabilities(await api<Capabilities>('/capabilities', jsonBody({}))); notify('Executable capabilities refreshed.'); }))} />
        </div>
        <footer className="page-footer"><span>MCM — a little more control.</span><span>Built for llama.cpp <span aria-hidden="true">↗</span></span></footer>
      </main>
    </div>
    <div className="toast-region" aria-live="polite" aria-atomic="true">{notice && !modal && <div className={`toast ${notice.error ? 'error' : ''}`} role={notice.error ? 'alert' : 'status'}>{notice.error ? <AlertCircle size={19} /> : <Check size={19} />}<span>{notice.message}</span><button className="icon-button" aria-label="Dismiss notification" onClick={() => setNotice(null)}><X size={16} /></button></div>}</div>
    {modal?.kind === 'metadata' && <MetadataDialog target={modal.target} workspace={workspace} busy={!!busy} onClose={closeModal} onSave={async (target, values) => run('metadata', async () => {
      const id = target.item?.id ?? crypto.randomUUID();
      if (target.kind === 'group') {
        const item = { id, name: values.name.trim(), values: target.item?.values ?? {} };
        await persist({ ...workspace, groups: target.item ? workspace.groups.map(group => group.id === id ? item : group) : [...workspace.groups, item] });
      } else {
        const item = { id, name: values.name.trim(), model: { filename: values.filename, ...(values.repo ? { repo: values.repo } : {}) }, ...(values.groupId ? { groupId: values.groupId } : {}), values: target.item?.values ?? {} };
        await persist({ ...workspace, models: target.item ? workspace.models.map(model => model.id === id ? item : model) : [...workspace.models, item] });
      }
      setSelection({ kind: target.kind, id });
      window.scrollTo({ top: 0 });
      setModal(null); notify(`${target.kind === 'model' ? 'Model' : 'Group'} ${target.item ? 'updated' : 'created'}.`);
    })} onDelete={async target => run('delete', async () => {
      const id = target.item?.id;
      const next: Workspace = target.kind === 'model' ? { ...workspace, models: workspace.models.filter(model => model.id !== id) }
        : { ...workspace, groups: workspace.groups.filter(group => group.id !== id), models: workspace.models.map(model => {
          if (model.groupId !== id) return model;
          const { groupId: _groupId, ...ungrouped } = model;
          return ungrouped;
        }) };
      await persist(next); setSelection({ kind: 'base' }); setModal(null); notify(`${target.kind === 'model' ? 'Model' : 'Group'} deleted.`);
    })} />}
    {modal?.kind === 'settings' && <SettingsDialog settings={settings} workspace={workspace} busy={!!busy} onClose={closeModal} onSave={async values => run('settings', async () => {
      const bindings = Object.fromEntries(Object.entries(values.modelBindings).filter(([, value]) => value !== ''));
      const result = await api<PublicSettings>('/settings', { method: 'PUT', body: JSON.stringify({ ...values, modelBindings: bindings }) });
      manager.setSettings(result); setCapabilities(null); setModal(null); notify('Machine settings saved. Running processes are unchanged until restart.');
    })} />}
    {modal?.kind === 'share' && <ShareDialog workspace={workspace} repo={settings.hfRepo} onClose={closeModal} notify={notify} onImport={(incoming, source) => setModal({ kind: 'import', workspace: incoming, source })} />}
    {modal?.kind === 'import' && <ImportDialog workspace={modal.workspace} current={workspace} source={modal.source} busy={!!busy} onClose={closeModal} onImport={() => void run('import', async () => {
      await persist(modal.workspace); setSelection({ kind: 'base' }); setModal(null); clearHash(); window.scrollTo({ top: 0 }); notify('Workspace imported. Machine settings are unchanged. No model was launched.');
    })} />}
    {modal?.kind === 'command' && <Dialog title="Command preview" subtitle="Built from the saved configuration and this machine’s local binding." onClose={closeModal} wide><div className="command-body"><pre tabIndex={0}>{[modal.executable, ...modal.args].map(argument => JSON.stringify(argument)).join(' ')}</pre><p className="field-help">Arguments are shown quoted for readability. The server launches the executable directly, without a shell.</p><div className="dialog-actions"><button className="button secondary" onClick={() => void (async () => {
      try { await navigator.clipboard.writeText([modal.executable, ...modal.args].map(argument => JSON.stringify(argument)).join(' ')); notify('Command copied.'); } catch { notify('Unable to access the clipboard.', true); }
    })()}><Copy size={15} />Copy command</button><div className="action-spacer" /><button className="button primary" onClick={closeModal}>Done</button></div></div></Dialog>}
  </div></FeedbackContext.Provider>;
}
