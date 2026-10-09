// The Analysis chat's side of the conversation: the lot in plain lines for the advisor, and the
// events the Analysis proxy (proxy/gemini) streams back. No network here.
import type { ErrorCode } from '../proxy/gemini/worker';

export interface InsightFacts {
  address: string;
  jurisdiction: string;
  area: string;
  /** Mode and dates, as the inspector already phrases them. */
  showing: string;
  measuredAt: string;
  headline: string;
  summary: string;
  lidar: string;
  thresholds: string;
  notices: string[];
}

const CAVEATS = [
  'The main hours are direct sun on clear days. Figures "with typical weather" allow for average cloud.',
  'Trees are treated as solid all year, so winter light through bare branches is understated.',
  'Lot lines are approximate, not a legal survey.',
  'Only buildings, trees and land within about 200 metres cast shadows.',
];

/** The first question, not shown: a short reading of the lot. */
export const OPENING_QUESTION =
  'Give a short practical reading of this lot: where the sun and shade fall, what that means for a garden or for sitting outside, and one thing to watch out for. Three short paragraphs at most.';

/** The lot, in lines a model can read. Empty fields are left out. */
export function formatInsightContext(facts: InsightFacts): string {
  const lines = [
    facts.address ? `Address: ${facts.address}` : '',
    facts.jurisdiction ? `Municipality: ${facts.jurisdiction}` : '',
    facts.area ? `Lot area: ${facts.area}` : '',
    facts.showing ? `Showing: ${facts.showing}` : '',
    facts.measuredAt ? `Measured at: ${facts.measuredAt}` : '',
    facts.lidar ? `Elevation: ${facts.lidar}` : '',
    facts.headline ? `Result: ${facts.headline}` : '',
    facts.summary ? `Comparison: ${facts.summary}` : '',
    facts.thresholds ? `Sun classes: ${facts.thresholds}` : '',
    ...facts.notices.filter((n) => n.trim()).map((n) => `Note: ${n.trim()}`),
    ...CAVEATS,
  ];
  return lines.filter((line) => line.length > 0).join('\n');
}

export type ChatEvent = { text: string } | { done: true } | { error: ErrorCode };

/** Complete events from the stream so far (`data: {…}` blocks); `rest` is the unfinished tail. */
export function takeEvents(buffer: string): { events: ChatEvent[]; rest: string } {
  const blocks = buffer.replaceAll('\r\n', '\n').split('\n\n');
  const rest = blocks.pop()!;
  const events: ChatEvent[] = [];
  for (const block of blocks) {
    const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).join('\n');
    try {
      const e = JSON.parse(data) as Partial<{ text: unknown; done: unknown; error: unknown }>;
      if (typeof e.text === 'string') events.push({ text: e.text });
      else if (e.done === true) events.push({ done: true });
      else if (e.error === 'busy' || e.error === 'limit' || e.error === 'failed') events.push({ error: e.error });
    } catch {
      /* a comment or keep-alive */
    }
  }
  return { events, rest };
}
