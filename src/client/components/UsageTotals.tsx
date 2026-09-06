import type { UsageSummary, UsageTotals as Totals } from '../../shared/types';

const tokens = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const dollars = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', minimumFractionDigits: 5, maximumFractionDigits: 5,
});

function UsageRow({ label, totals, since }: { label: string; totals: Totals; since: string }) {
  const cost = totals.costUsd === null ? null
    : totals.costUsd > 0 && totals.costUsd < 0.00001 ? '<$0.00001' : dollars.format(totals.costUsd);
  return <section className="usage-period" aria-label={`${label} usage`}>
    <div className="usage-period-heading"><h3>{label}</h3><span title={`Since ${new Date(since).toLocaleString()}`}>{tokens.format(totals.requestCount)} requests</span></div>
    <dl className="usage-token-grid">
      <div><dt>Input</dt><dd>{tokens.format(totals.inputTokens)}</dd></div>
      <div><dt>Output</dt><dd>{tokens.format(totals.outputTokens)}</dd></div>
      <div><dt>Total tokens</dt><dd>{tokens.format(totals.inputTokens + totals.outputTokens)}</dd></div>
    </dl>
    <div className="usage-cost">    <span>Estimated token value <abbr title="US dollars">USD</abbr></span><strong>{cost ?? (totals.unpricedTokens > 0 ? 'Unpriced' : totals.requestCount > 0 ? 'Unavailable' : '—')}</strong></div>
    {totals.unpricedTokens > 0 && <p className="field-help usage-unpriced-note">{tokens.format(totals.unpricedTokens)} tokens unpriced{cost !== null ? ' - excluded from cost' : ' - no matching model price was recorded'}. Price changes apply only to new requests.</p>}
    {totals.missingUsageRequests > 0 && <p className="field-help">{tokens.format(totals.missingUsageRequests)} requests with incomplete usage; totals include reported tokens only.</p>}
  </section>;
}

export function UsageTotals({ usage }: { usage: UsageSummary | null }) {
  return <div className="usage-summary">
    {!usage ? <p className="field-help">Loading recorded usage...</p> : <>
      <UsageRow label="All-time" totals={usage.allTime} since={usage.trackingStartedAt} />
      <UsageRow label="Current session" totals={usage.session} since={usage.sessionStartedAt} />
      <p className="field-help usage-summary-note">Includes live reported usage; saved when requests end. Session = this MCM server run.</p>
      {usage.error && <p className="inline-error" role="alert">{usage.error}</p>}
    </>}
  </div>;
}
