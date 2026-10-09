// Plain-language facts for the Analysis chat, and the small bits of stream parsing the dev
// server shares with tests. No network here.

export interface InsightFacts {
  address: string;
  jurisdiction: string;
  area: string;
  /** Mode, date and time, as the inspector already phrases them. */
  showing: string;
  measuredAt: string;
  headline: string;
  summary: string;
  lidar: string;
  thresholds: string;
  notices: string[];
}

const CAVEATS = [
  'Hours are clear-sky direct sun. Cloud and rain are not included.',
  'Trees are treated as solid all year, so winter light through bare branches is understated.',
  'Lot lines are approximate, not a legal survey.',
  'Only objects within about 200 metres cast shadows.',
];

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
    facts.thresholds ? `Colour scale: ${facts.thresholds}` : '',
    ...facts.notices.filter((n) => n.trim()).map((n) => `Note: ${n.trim()}`),
    ...CAVEATS,
  ];
  return lines.filter((line) => line.length > 0).join('\n');
}

/** Instructions plus the latest lot facts. The question is sent separately so a chat API can keep a system role. */
export function advisorInstructions(context: string): string {
  return [
    'You are the advisor inside VanShade, a sun and shade map for one Metro Vancouver lot. The person is deciding where to garden or spend time outside.',
    'Reply in plain sentences for a gardener. No headings, and do not mention software, files, or tools.',
    'Use only the lot facts below and the conversation so far. If the facts do not say, say you do not know.',
    'There is no repository. Do not edit files, run commands, browse, or call tools. The reply is the whole answer.',
    '',
    'Lot facts:',
    context.trim(),
  ].join('\n');
}

/** Instructions plus the latest lot facts and question. Sent as one prompt where there is no system role. */
export function buildAdvisorPrompt(context: string, question: string): string {
  return [advisorInstructions(context), '', 'Question:', question.trim()].join('\n');
}

/** Visible reply text from one Gemini stream chunk. Thinking parts are left out. */
export function geminiChunkText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const candidates = (payload as { candidates?: unknown }).candidates;
  const first = Array.isArray(candidates) ? candidates[0] : undefined;
  if (!first || typeof first !== 'object') return '';
  const parts = (first as { content?: { parts?: unknown } }).content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((part): part is { text: string } => {
      if (!part || typeof part !== 'object') return false;
      const row = part as { text?: unknown; thought?: unknown };
      return typeof row.text === 'string' && row.thought !== true;
    })
    .map((part) => part.text)
    .join('');
}

export interface SseEvent {
  event: string;
  data: string;
}

/** Pull complete SSE blocks out of a byte stream. `rest` is the incomplete tail. */
export function takeSseEvents(buffer: string): { events: SseEvent[]; rest: string } {
  const events: SseEvent[] = [];
  let rest = buffer.replaceAll('\r\n', '\n');
  while (true) {
    const split = rest.indexOf('\n\n');
    if (split < 0) break;
    const block = rest.slice(0, split);
    rest = rest.slice(split + 2);
    if (!block.trim()) continue;
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    events.push({ event, data: data.join('\n') });
  }
  return { events, rest };
}

/**
 * Assistant text from Cursor is usually a delta, and sometimes a growing snapshot of the same reply.
 * Returns the full text so far.
 */
export function mergeAssistantText(soFar: string, next: string): string {
  if (!next) return soFar;
  if (next.startsWith(soFar)) return next;
  return soFar + next;
}

export type AdvisorProblem = 'failed' | 'no-repo' | 'no-key' | 'busy';

/** Turn a Cursor error body into a code the chat can show. The detail is a short sentence, never a page of HTML. */
export function explainAdvisorFailure(message: string): { code: AdvisorProblem; detail: string } {
  const detail = message.replace(/\s+/g, ' ').trim().slice(0, 240);
  const lower = detail.toLowerCase();
  if (/repository|no-repo|"repos"/.test(lower)) return { code: 'no-repo', detail: '' };
  if (lower.includes('unauthorized') || lower.includes('invalid api key') || lower.includes('api key')) return { code: 'no-key', detail: '' };
  if (lower.includes('too many') || lower.includes('rate limit') || lower.includes('high demand') || lower.includes('unavailable')) return { code: 'busy', detail: '' };
  return { code: 'failed', detail: detail.startsWith('<') ? '' : detail };
}
