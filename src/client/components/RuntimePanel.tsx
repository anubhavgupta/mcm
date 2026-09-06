import { Activity, Check, CircleHelp, Copy, FileTerminal, Radio, RefreshCw, Terminal, Trash2 } from 'lucide-react';
import type { Capabilities, LogEntry, ServerStatus, Throughput } from '../../shared/types';
import { catalog, fieldSupported } from '../../shared/config';

export function RuntimePanel({ connected, status, throughput, logs, clearLogs, notify, preview, canPreview, probe, capabilities, busy }: {
  connected: boolean; status: ServerStatus | null; throughput: Throughput | null; logs: LogEntry[];
  clearLogs: () => void; notify: (text: string, error?: boolean) => void;
  preview: () => void; canPreview: boolean; probe: () => void; capabilities: Capabilities | null; busy: boolean;
}) {
  const metric = (value: number | null | undefined) => value === null || value === undefined ? '—' : value.toFixed(1);
  const copyLogs = async () => {
    try {
      await navigator.clipboard.writeText(logs.map(log => `[${log.timestamp}] [${log.stream}] ${log.text}`).join('\n'));
      notify('Logs copied to clipboard.');
    } catch { notify('Unable to access the clipboard.', true); }
  };
  const supported = capabilities ? catalog.fields.filter(field => fieldSupported(field, capabilities.flags)).length : 0;
  return <aside className="runtime-panel" aria-label="Runtime">
    <section className="runtime-card"><div className="runtime-heading"><h2><Activity size={16} />Inference</h2><span className={`status-pill ${connected ? 'live' : ''}`}><span className="tiny-dot" />{connected ? 'LIVE' : 'OFFLINE'}</span></div>
      <p className="runtime-description">Measured throughput, not estimates.</p>
      <div className="metrics-grid"><div><span>Prompt processing <abbr title="Prompt processing">PP</abbr></span><strong>{metric(throughput?.pp)}</strong><small>{throughput?.pp == null ? 'Unavailable · tokens/sec' : 'tokens/sec'}</small></div><div><span>Token generation <abbr title="Token generation">TG</abbr></span><strong>{metric(throughput?.tg)}</strong><small>{throughput?.tg == null ? 'Unavailable · tokens/sec' : 'tokens/sec'}</small></div></div>
      <div className="metric-footnote"><Radio size={13} />{!connected ? 'Disconnected · last received values'
        : throughput?.measurement === 'prometheus' ? 'Server metrics · Aggregate rates'
          : throughput ? `${throughput.protocol === 'openai' ? 'OpenAI' : 'Anthropic'} · ${throughput.active ? 'Request in progress' : 'Last request'}${throughput.source === 'unavailable' ? ' · timing unavailable' : throughput.measurement === 'timings' ? ' · Request timings' : ''}`
            : 'Waiting for an inference request'}</div>
      {throughput && <div className="token-counts"><span>Input <strong>{throughput.inputTokens ?? '—'}</strong></span><span>Output <strong>{throughput.outputTokens ?? '—'}</strong></span></div>}
    </section>
    <section className="runtime-card executable-card"><div className="runtime-heading"><h2><FileTerminal size={16} />Executable</h2></div>
      <p className="runtime-description">{capabilities ? `${supported} of ${catalog.fields.length} settings supported by this build.` : 'Check your llama.cpp build for compatible flags and aliases.'}</p>
      {capabilities && <div className={`capability-result ${supported === catalog.fields.length ? 'success' : ''}`}>{supported === catalog.fields.length ? <Check size={14} /> : <CircleHelp size={14} />}{supported === catalog.fields.length ? 'All catalog fields supported' : `${catalog.fields.length - supported} unsupported fields marked in the editor`}</div>}
      <div className="runtime-buttons"><button className="button secondary" onClick={probe} disabled={busy}><RefreshCw size={14} />Probe executable</button><button className="text-button" onClick={preview} disabled={!canPreview || busy}><Terminal size={14} />Preview command</button></div><p className="field-help">Preview and launch use saved settings only.</p>
    </section>
    <section className="runtime-card logs-card"><div className="runtime-heading"><h2><Terminal size={16} />Server logs</h2><div className="log-actions"><button className="icon-button" onClick={() => void copyLogs()} aria-label="Copy logs" disabled={!logs.length}><Copy size={14} /></button><button className="icon-button" onClick={clearLogs} aria-label="Clear logs" disabled={!logs.length}><Trash2 size={14} /></button></div></div>
      <div className="log-window" role="log" aria-label="Server log output" aria-live="off" tabIndex={0}>
        {!logs.length ? <div className="log-empty"><Terminal size={25} /><strong>A quiet console.</strong><p>{connected ? 'Server output will appear here when a model is launched.' : 'Reconnecting to the event stream. Logs will replay automatically.'}</p></div> : logs.map((log, index) => <div className={`log-line ${log.stream}`} key={`${log.timestamp}-${index}`}><time>{Number.isNaN(Date.parse(log.timestamp)) ? log.timestamp : new Date(log.timestamp).toLocaleTimeString([], { hour12: false })}</time><span>{log.text}</span></div>)}
      </div><div className="log-footer"><span>{logs.length} / 500 lines</span><span>{connected ? 'Stream connected' : 'Reconnecting…'}</span></div>
    </section>
    <div className="runtime-tip"><CircleHelp size={16} /><p>One workspace, any machine.<br /><span>Share the configuration. Keep your local setup local.</span></p></div>
    {status?.error && <p className="inline-error" role="alert">{status.error}</p>}
  </aside>;
}
