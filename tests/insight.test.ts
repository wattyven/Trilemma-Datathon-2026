import { describe, expect, it } from 'vitest';
import { advisorInstructions, buildAdvisorPrompt, explainAdvisorFailure, formatInsightContext, geminiChunkText, geminiPayloadText, mergeAssistantText, takeSseEvents, takeSseEventsEnd, type InsightFacts } from '../src/insight';

const facts: InsightFacts = {
  address: '453 W 12th Ave, Vancouver, BC',
  jurisdiction: 'City of Vancouver',
  area: '2,400 m²',
  showing: 'Moment: 2026-06-21 at 15:30',
  measuredAt: 'garden bed, 0.3 m above the ground',
  headline: 'At 3:30 pm on 21 June, 70% of the open ground is in direct sun.',
  summary: 'The sun is 45° above the horizon, in the south-west.',
  lidar: '2016, with 2025 updates near the lot',
  thresholds: '',
  notices: ['Lot lines come from ParcelMap BC.'],
};

describe('formatInsightContext', () => {
  it('puts the lot in labelled lines and always includes the caveats', () => {
    const text = formatInsightContext(facts);
    expect(text).toContain('Address: 453 W 12th Ave, Vancouver, BC');
    expect(text).toContain('Result: At 3:30 pm on 21 June');
    expect(text).toContain('Note: Lot lines come from ParcelMap BC.');
    expect(text).toContain('Cloud and rain are not included.');
    expect(text).not.toContain('Colour scale:');
  });
});

describe('buildAdvisorPrompt', () => {
  it('keeps the question and tells the advisor not to edit anything', () => {
    const prompt = buildAdvisorPrompt(formatInsightContext(facts), 'Where should I plant vegetables?');
    expect(prompt).toContain('Where should I plant vegetables?');
    expect(prompt).toContain('453 W 12th Ave');
    expect(prompt).toContain('Do not edit files');
    expect(prompt.startsWith(advisorInstructions(formatInsightContext(facts)))).toBe(true);
  });
});

describe('geminiChunkText', () => {
  it('keeps the reply and drops a thinking part', () => {
    const text = geminiChunkText({
      candidates: [{ content: { parts: [{ thought: true, text: 'planning' }, { text: 'The south bed is sunny.' }] } }],
    });
    expect(text).toBe('The south bed is sunny.');
  });
});

describe('geminiPayloadText', () => {
  it('reads every JSON object in one data block and skips thinking', () => {
    const data = [
      '{"candidates":[{"content":{"parts":[{"thought":true,"text":"planning"}]}}]}',
      '{"candidates":[{"content":{"parts":[{"text":"The south bed is sunny."}]}}]}',
    ].join('\n');
    expect(geminiPayloadText(data)).toBe('The south bed is sunny.');
  });
});

describe('takeSseEvents', () => {
  it('splits complete events and keeps a partial tail', () => {
    const { events, rest } = takeSseEvents('event: assistant\ndata: {"text":"Hi"}\n\nevent: result\ndata: {"sta');
    expect(events).toEqual([{ event: 'assistant', data: '{"text":"Hi"}' }]);
    expect(rest).toBe('event: result\ndata: {"sta');
  });

  it('keeps a last event that has no trailing blank line', () => {
    const { events, rest } = takeSseEventsEnd('data: {"text":"Hi"}');
    expect(events).toEqual([{ event: 'message', data: '{"text":"Hi"}' }]);
    expect(rest).toBe('');
  });
});

describe('explainAdvisorFailure', () => {
  it('keeps a short Cursor sentence and hides pages and key errors', () => {
    expect(explainAdvisorFailure('Run ended ERROR')).toEqual({ code: 'failed', detail: 'Run ended ERROR' });
    expect(explainAdvisorFailure('<html>bad gateway</html>')).toEqual({ code: 'failed', detail: '' });
    expect(explainAdvisorFailure('A repository is required').code).toBe('no-repo');
    expect(explainAdvisorFailure('Invalid API key').code).toBe('no-key');
    expect(explainAdvisorFailure('{ "error": { "code": 503, "message": "This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.", "status": "UNAVAILABLE" } }')).toEqual({ code: 'busy', detail: '' });
  });
});

describe('mergeAssistantText', () => {
  it('appends a delta and replaces when the next chunk is the whole reply', () => {
    expect(mergeAssistantText('Hel', 'lo')).toBe('Hello');
    expect(mergeAssistantText('Hel', 'Hello')).toBe('Hello');
  });
});
