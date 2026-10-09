import { describe, expect, it } from 'vitest';
import { formatInsightContext, takeEvents, type InsightFacts } from '../src/insight';

const facts: InsightFacts = {
  address: '453 W 12th Ave, Vancouver, BC',
  jurisdiction: 'City of Vancouver',
  area: '2,400 m²',
  showing: '1 Apr – 30 Sep 2026: average',
  measuredAt: 'garden bed, 0.3 m above the ground',
  headline: 'Most of the open ground here gets 6–9 hours of direct sun a day (full sun) in the growing season.',
  summary: 'For comparison, open ground with nothing around it would get 14.6 hours of sun a day (about 7.7 with typical weather).',
  lidar: '2016, with 2025 updates near the lot',
  thresholds: '',
  notices: ['Lot lines come from ParcelMap BC.', '  '],
};

describe('formatInsightContext', () => {
  it('puts the lot in labelled lines, leaves out empty ones and always adds the caveats', () => {
    const text = formatInsightContext(facts);
    expect(text).toContain('Address: 453 W 12th Ave, Vancouver, BC');
    expect(text).toContain('Result: Most of the open ground here gets 6–9 hours');
    expect(text).toContain('Note: Lot lines come from ParcelMap BC.');
    expect(text).not.toMatch(/^Note:\s*$/m);
    expect(text).not.toContain('Sun classes:');
    expect(text).toContain('direct sun on clear days');
  });
});

describe('takeEvents', () => {
  it('reads complete events and keeps a partial tail', () => {
    const { events, rest } = takeEvents('data: {"text":"The south "}\n\ndata: {"text":"bed"}\r\n\r\ndata: {"do');
    expect(events).toEqual([{ text: 'The south ' }, { text: 'bed' }]);
    expect(rest).toBe('data: {"do');
  });

  it('knows the end, the proxy error codes, and skips anything else', () => {
    const { events } = takeEvents('data: {"done":true}\n\ndata: {"error":"limit"}\n\ndata: {"error":"teapot"}\n\n: keep-alive\n\n');
    expect(events).toEqual([{ done: true }, { error: 'limit' }]);
  });
});
