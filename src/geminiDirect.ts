// Browser call to Gemini for the static site. The key is baked in at build time (GitHub variable
// VITE_GEMINI_API_KEY). Local `npm run dev` keeps using the server and .env.local instead.
import { geminiPayloadText, mergeAssistantText, takeSseEvents, takeSseEventsEnd } from './insight';

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse';

export interface GeminiTurn {
  role: 'user' | 'model';
  text: string;
}

export class GeminiChatError extends Error {
  constructor(readonly code: 'no-key' | 'busy' | 'failed', readonly detail = '') {
    super(detail || code);
    this.name = 'GeminiChatError';
  }
}

/** Stream one visible reply. Retries a thinking-only answer once with thinking off. */
export async function streamGemini(opts: {
  key: string;
  instructions: string;
  turns: GeminiTurn[];
  message: string;
  signal: AbortSignal;
  onText: (extra: string) => void;
}): Promise<string> {
  const contents = [
    ...opts.turns.map((turn) => ({ role: turn.role, parts: [{ text: turn.text }] })),
    { role: 'user' as const, parts: [{ text: opts.message }] },
  ];
  let text = await once(opts.key, opts.instructions, contents, true, opts.signal, opts.onText);
  if (!text.trim()) text = await once(opts.key, opts.instructions, contents, false, opts.signal, opts.onText);
  return text;
}

async function once(
  key: string,
  instructions: string,
  contents: { role: 'user' | 'model'; parts: { text: string }[] }[],
  allowThinking: boolean,
  signal: AbortSignal,
  onText: (extra: string) => void,
): Promise<string> {
  const generationConfig: { maxOutputTokens: number; thinkingConfig?: { thinkingLevel: string } } = { maxOutputTokens: 800 };
  if (allowThinking) generationConfig.thinkingConfig = { thinkingLevel: 'low' };
  let res = await post(key, instructions, contents, generationConfig, signal);
  for (let attempt = 0; attempt < 2 && (res.status === 429 || res.status === 503); attempt++) {
    await res.body?.cancel().catch(() => undefined);
    await delay(1000 * (attempt + 1), signal);
    res = await post(key, instructions, contents, generationConfig, signal);
  }
  if (res.status === 400) {
    const detail = await res.text();
    if (!/thinking/i.test(detail) || !allowThinking) throw fail(400, detail);
    delete generationConfig.thinkingConfig;
    res = await post(key, instructions, contents, generationConfig, signal);
  }
  if (!res.ok || !res.body) throw fail(res.status, await res.text().catch(() => ''));
  return readReply(res.body, signal, onText);
}

async function post(
  key: string,
  instructions: string,
  contents: { role: 'user' | 'model'; parts: { text: string }[] }[],
  generationConfig: { maxOutputTokens: number; thinkingConfig?: { thinkingLevel: string } },
  signal: AbortSignal,
): Promise<Response> {
  return fetch(GEMINI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: instructions }] },
      contents,
      generationConfig,
    }),
    signal,
  });
}

async function readReply(body: ReadableStream<Uint8Array>, signal: AbortSignal, onText: (extra: string) => void): Promise<string> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let soFar = '';
  const push = (data: string) => {
    const merged = mergeAssistantText(soFar, geminiPayloadText(data));
    const extra = merged.slice(soFar.length);
    soFar = merged;
    if (extra) onText(extra);
  };
  const take = (events: { data: string }[]) => {
    for (const ev of events) if (ev.data && ev.data !== '[DONE]') push(ev.data);
  };
  while (!signal.aborted) {
    const { done, value } = await reader.read();
    if (value) buf += dec.decode(value, { stream: !done });
    if (done) {
      take(takeSseEventsEnd(buf).events);
      break;
    }
    const taken = takeSseEvents(buf);
    buf = taken.rest;
    take(taken.events);
  }
  return soFar;
}

function fail(status: number, detail: string): GeminiChatError {
  if (status === 401 || status === 403) return new GeminiChatError('no-key');
  if (status === 429 || status === 503) return new GeminiChatError('busy');
  const short = detail.replace(/\s+/g, ' ').trim().slice(0, 240);
  return new GeminiChatError('failed', short.startsWith('<') ? '' : short);
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}
