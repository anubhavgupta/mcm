import type { ReactNode } from 'react';
import { Activity, Radio } from 'lucide-react';
import type { Throughput, UsageSummary } from '../../shared/types';
import { UsageTotals } from './UsageTotals';

export function InferenceCard({ connected, throughput, usage, control }: {
  connected: boolean; throughput: Throughput | null; usage: UsageSummary | null; control?: ReactNode;
}) {
  const metric = (value: number | null | undefined) => value == null ? '—' : value.toFixed(1);
  return <section className="runtime-card">
    <div className="runtime-heading"><h2><Activity size={16} />Inference</h2><div className="inference-heading-actions"><span className={`status-pill ${connected ? 'live' : ''}`}><span className="tiny-dot" />{connected ? 'LIVE' : 'OFFLINE'}</span>{control}</div></div>
    <div className="metrics-grid"><div><span>Prompt processing <abbr title="Prompt processing">PP</abbr></span><strong>{metric(throughput?.pp)}</strong><small>{throughput?.pp == null ? 'Unavailable · tokens/sec' : 'tokens/sec'}</small></div><div><span>Token generation <abbr title="Token generation">TG</abbr></span><strong>{metric(throughput?.tg)}</strong><small>{throughput?.tg == null ? 'Unavailable · tokens/sec' : 'tokens/sec'}</small></div></div>
    <div className="metric-footnote"><Radio size={13} />{!connected ? 'Disconnected · last received values'
      : throughput?.measurement === 'prometheus' ? 'Server metrics · Aggregate rates'
        : throughput ? `${throughput.protocol === 'openai' ? 'OpenAI' : 'Anthropic'} · ${throughput.active ? 'Request in progress' : 'Last request'}${throughput.source === 'unavailable' ? ' · timing unavailable' : throughput.measurement === 'timings' ? ' · Request timings' : ''}`
          : 'Waiting for an inference request'}</div>
    {throughput && <div className="token-counts"><span>Request input <strong>{throughput.inputTokens ?? '—'}</strong></span><span>Request output <strong>{throughput.outputTokens ?? '—'}</strong></span></div>}
    <UsageTotals usage={usage} />
  </section>;
}
