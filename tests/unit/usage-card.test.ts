import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { UsageTotals } from '../../src/client/components/UsageTotals';
import { emptyUsageTotals } from '../../src/shared/usage';
import type { UsageSummary } from '../../src/shared/types';

function fixture(): UsageSummary {
  return {
    allTime: { ...emptyUsageTotals(), inputTokens: 100, outputTokens: 25, requestCount: 2 },
    session: { ...emptyUsageTotals(), inputTokens: 20, outputTokens: 5, requestCount: 1 },
    sessionId: 'session', sessionStartedAt: '2026-01-01T00:00:00.000Z', trackingStartedAt: '2025-12-31T00:00:00.000Z',
  };
}

describe('recorded usage card', () => {
  it('shows both scopes with combined totals instead of summing all-time and session', () => {
    const markup = renderToStaticMarkup(createElement(UsageTotals, { usage: fixture() }));
    expect(markup).toContain('All-time usage');
    expect(markup).toContain('Current session usage');
    expect(markup).toContain('<dt>Total tokens</dt><dd>125</dd>');
    expect(markup).toContain('<dt>Total tokens</dt><dd>25</dd>');
    expect(markup).toContain('Estimated token value');
    expect(markup).toContain('Unavailable');
  });
  it('explains unpriced usage rather than hiding its cost row', () => {
    const usage = fixture();
    usage.allTime.unpricedTokens = 125;
    const markup = renderToStaticMarkup(createElement(UsageTotals, { usage }));
    expect(markup).toContain('Unpriced');
    expect(markup).toContain('no matching model price was recorded');
  });
  it('shows configured free usage as zero cost, not unavailable', () => {
    const usage = fixture();
    usage.session.costUsd = 0;
    const markup = renderToStaticMarkup(createElement(UsageTotals, { usage }));
    expect(markup).toContain('Estimated token value');
    expect(markup).toContain('<strong>$0.00000</strong>');
  });
  it('does not round a positive sub-microdollar cost to free', () => {
    const usage = fixture();
    usage.session.costUsd = 0.0000001;
    expect(renderToStaticMarkup(createElement(UsageTotals, { usage }))).toContain('&lt;$0.00001');
  });
  it.each([
    [0.1, '$0.10000'],
    [0.1234, '$0.12340'],
    [0.12345, '$0.12345'],
    [0.123456, '$0.12346'],
    [1, '$1.00000'],
  ])('shows exactly five decimal places for %s in both usage rows', (value, expected) => {
    const usage = fixture();
    usage.allTime.costUsd = value;
    usage.session.costUsd = value;
    const markup = renderToStaticMarkup(createElement(UsageTotals, { usage }));
    expect(markup.split(`<strong>${expected}</strong>`)).toHaveLength(3);
    expect(usage.allTime.costUsd).toBe(value);
  });
  it('labels partial pricing, incomplete usage and accounting errors', () => {
    const usage = fixture();
    usage.session.costUsd = 0.5;
    usage.session.unpricedTokens = 12;
    usage.session.missingUsageRequests = 1;
    usage.error = 'Could not persist usage.';
    const markup = renderToStaticMarkup(createElement(UsageTotals, { usage }));
    expect(markup).toContain('12 tokens unpriced - excluded from cost');
    expect(markup).toContain('1 requests with incomplete usage');
    expect(markup).toContain('Could not persist usage.');
  });
});
