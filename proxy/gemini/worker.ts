// VanShade Analysis proxy: a Cloudflare Worker that answers the site's Analysis questions with
// Google's Gemini. It holds the API key (a Worker secret), so the key never reaches a browser.
// POST /chat only, from the site's own origins. It writes the advisor's instructions itself, fixes
// the model and caps every length, so it can't be used as a general-purpose Gemini endpoint.
// Deploy: see README.md in this folder.

export const MODEL = 'gemini-3.8-flash';
const GEMINI = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`;
/** Characters, except `body` (bytes) and `turns` (messages, the new question included). */
export const LIMITS = { body: 64_000, context: 8_000, question: 2_000, answer: 10_000, turns: 9 } as const;
/** Includes the model's thinking, so it leaves room for a full answer after it. */
const MAX_OUTPUT_TOKENS = 2_048;
const RETRY_MS = [1_000, 2_000]; // Gemini's 429 and 503 ("high demand") usually clear in a moment
const DAY = 86_400;

export interface Env {
  GEMINI_API_KEY?: string;
  /** Comma-separated. Browsers from other origins, and requests without one, get a 403. Empty: any. */
  ALLOWED_ORIGINS?: string;
  /** Cloudflare's rate-limiting binding (wrangler.toml), keyed by the visitor's IP. */
  LIMITER?: { limit(o: { key: string }): Promise<{ success: boolean }> };
}

interface Context {
  waitUntil(p: Promise<unknown>): void;
}

export interface Turn {
  role: 'user' | 'model';
  text: string;
}

/** What the browser hears: reply text as it arrives, then `done`, or an `error` code instead. */
export type ErrorCode = 'busy' | 'limit' | 'failed';

export function instructions(context: string): string {
  return [
    'You are the advisor in VanShade, a sun and shade map for one lot in Metro Vancouver. The person is deciding where to garden or spend time outside.',
    'Answer in short, plain sentences for a gardener. Write plain text: no Markdown, asterisks, headings, lists or tables. Do not mention software, models or data files.',
    'Use only the lot facts below and the conversation so far. If they do not answer the question, say so.',
    'Only help with this lot: its sun and shade, and gardening or time outside that depends on them. Politely decline anything else.',
    '',
    'Lot facts:',
    context.trim(),
  ].join('\n');
}

/** The request body, checked; null when anything is missing, the wrong shape or too long. */
export function parseChat(raw: unknown): { context: string; turns: Turn[] } | null {
  if (!raw || typeof raw !== 'object') return null;
  const { context, turns } = raw as { context?: unknown; turns?: unknown };
  if (typeof context !== 'string' || !context.trim() || context.length > LIMITS.context) return null;
  if (!Array.isArray(turns) || turns.length % 2 !== 1 || turns.length > LIMITS.turns) return null;
  const out: Turn[] = [];
  for (const [i, t] of turns.entries()) {
    const role = i % 2 === 0 ? 'user' : 'model'; // alternating, starting and ending with the person
    const text = (t as { text?: unknown } | null)?.text;
    if ((t as { role?: unknown } | null)?.role !== role || typeof text !== 'string' || !text.trim()) return null;
    if (text.length > (role === 'user' ? LIMITS.question : LIMITS.answer)) return null;
    out.push({ role, text });
  }
  return { context, turns: out };
}

/** Visible reply text in one streamed Gemini chunk (thinking parts left out). */
export function chunkText(payload: unknown): string {
  const parts = (payload as { candidates?: { content?: { parts?: unknown } }[] } | null)?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map((p: { text?: unknown; thought?: unknown }) => (typeof p?.text === 'string' && p.thought !== true ? p.text : '')).join('');
}

function allowedOrigin(request: Request, env: Env): string | null {
  const origin = request.headers.get('Origin');
  const list = (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length) return origin ?? '*';
  return origin && list.includes(origin) ? origin : null;
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': String(DAY),
    Vary: 'Origin',
  };
}

const json = (body: object, status: number, cors: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function askGemini(key: string, context: string, turns: Turn[]): Promise<Response> {
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: instructions(context) }] },
    contents: turns.map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
    generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS, thinkingConfig: { thinkingLevel: 'low' } },
  });
  const post = () => fetch(GEMINI, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body });
  let res = await post();
  for (const ms of RETRY_MS) {
    if (res.status !== 429 && res.status !== 503) break;
    await res.body?.cancel();
    await wait(ms);
    res = await post();
  }
  return res;
}

/** Gemini's event stream in, ours out: `{text}` as visible text arrives, then `{done}` or `{error}`. */
async function relay(upstream: ReadableStream<Uint8Array>, writable: WritableStream<Uint8Array>) {
  const reader = upstream.getReader();
  const writer = writable.getWriter();
  const enc = new TextEncoder(), dec = new TextDecoder();
  const send = (o: object) => writer.write(enc.encode(`data: ${JSON.stringify(o)}\n\n`));
  let buf = '', any = false, finish = '';
  const take = async (line: string) => {
    if (!line.startsWith('data:')) return;
    let payload: { candidates?: { finishReason?: string }[]; promptFeedback?: { blockReason?: string } };
    try {
      payload = JSON.parse(line.slice(5));
    } catch {
      return; // a keep-alive or a partial line
    }
    finish = payload.candidates?.[0]?.finishReason ?? payload.promptFeedback?.blockReason ?? finish;
    const text = chunkText(payload);
    if (text) {
      any = true;
      await send({ text });
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buf += dec.decode(value, { stream: !done });
      const lines = buf.split(/\r?\n/);
      buf = done ? '' : lines.pop()!;
      for (const line of lines) await take(line);
      if (done) break;
    }
    if (!any) console.error(`Gemini sent no text (${finish || 'no finish reason'})`);
    await send(any ? { done: true } : { error: 'failed' satisfies ErrorCode });
    await writer.close();
  } catch (e) {
    // The visitor closed the panel or left (the write failed), or Gemini's stream broke.
    await reader.cancel().catch(() => {});
    await send({ error: 'failed' satisfies ErrorCode }).catch(() => {});
    await writer.abort(e).catch(() => {});
  }
}

export default {
  async fetch(request: Request, env: Env = {}, ctx?: Context): Promise<Response> {
    const origin = allowedOrigin(request, env);
    if (!origin) return new Response('Origin not allowed', { status: 403 });
    const cors = corsHeaders(origin);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (new URL(request.url).pathname !== '/chat') return new Response('Not found', { status: 404, headers: cors });
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: cors });

    const raw = await request.text();
    let chat: ReturnType<typeof parseChat> = null;
    try {
      chat = raw.length <= LIMITS.body ? parseChat(JSON.parse(raw)) : null;
    } catch {
      /* not JSON */
    }
    if (!chat) return json({ error: 'failed' satisfies ErrorCode }, 400, cors);

    if (env.LIMITER) {
      const { success } = await env.LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') ?? 'unknown' });
      if (!success) return json({ error: 'limit' satisfies ErrorCode }, 429, cors);
    }
    if (!env.GEMINI_API_KEY) {
      console.error('GEMINI_API_KEY is not set: npx wrangler secret put GEMINI_API_KEY');
      return json({ error: 'failed' satisfies ErrorCode }, 503, cors);
    }

    const upstream = await askGemini(env.GEMINI_API_KEY, chat.context, chat.turns);
    if (!upstream.ok || !upstream.body) {
      const detail = (await upstream.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
      console.error(`Gemini ${upstream.status}: ${detail}`); // `npx wrangler tail` shows these
      const busy = upstream.status === 429 || upstream.status === 503;
      return json({ error: (busy ? 'busy' : 'failed') satisfies ErrorCode }, busy ? 503 : 502, cors);
    }
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const pumping = relay(upstream.body, writable);
    ctx?.waitUntil(pumping);
    return new Response(readable, { headers: { ...cors, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' } });
  },
};
