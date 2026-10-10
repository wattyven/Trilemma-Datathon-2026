// The Analysis proxy (proxy/gemini/worker.ts) with Gemini stubbed.
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { chunkText, LIMITS, MODEL, parseChat, type Env } from '../proxy/gemini/worker';
import { GOAL_QUESTIONS, OPENING_QUESTION } from '../src/insight';

const SITE = 'https://vanshade.ca';
const env: Env = { GEMINI_API_KEY: 'test-key', ALLOWED_ORIGINS: `${SITE},http://localhost:5180` };
const chat = { context: 'Address: 453 W 12th Ave', turns: [{ role: 'user', text: 'Where should I plant tomatoes?' }] };

const post = (body: unknown, origin: string | null = SITE, e: Env = env) =>
  worker.fetch(
    new Request('https://proxy.example/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    e,
  );

/** Gemini's event stream, from chunk payloads. */
const sse = (...chunks: object[]) =>
  new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
const say = (text: string, thought = false) => ({ candidates: [{ content: { parts: [{ text, ...(thought ? { thought } : {}) }] } }] });

afterEach(() => vi.unstubAllGlobals());

describe('the Analysis proxy', () => {
  it('turns Gemini\'s stream into text events, leaving out thinking, and ends with done', async () => {
    const gemini = vi.fn(async (_url: string, _init: RequestInit) => sse(say('planning', true), say('The south '), say('bed is sunniest.')));
    vi.stubGlobal('fetch', gemini);
    const res = await post(chat);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/^text\/event-stream/);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(SITE);
    expect(await res.text()).toBe('data: {"text":"The south "}\n\ndata: {"text":"bed is sunniest."}\n\ndata: {"done":true}\n\n');

    // The key goes to Gemini in a header; the instructions and model are the proxy's own.
    const [url, init] = gemini.mock.calls[0]!;
    expect(url).toContain(`/models/${MODEL}:streamGenerateContent?alt=sse`);
    expect(url).not.toContain('test-key');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('test-key');
    const sent = JSON.parse(init.body as string);
    expect(sent.systemInstruction.parts[0].text).toMatch(/advisor in VanShade[\s\S]*Lot facts:\nAddress: 453 W 12th Ave$/);
    expect(sent.contents).toEqual([{ role: 'user', parts: [{ text: 'Where should I plant tomatoes?' }] }]);
    expect(sent.generationConfig.maxOutputTokens).toBeGreaterThanOrEqual(1024);
  });

  it('answers only its own sites, and requests with no origin get a 403', async () => {
    const gemini = vi.fn();
    vi.stubGlobal('fetch', gemini);
    expect((await post(chat, 'https://elsewhere.example')).status).toBe(403);
    expect((await post(chat, null)).status).toBe(403);
    expect(gemini).not.toHaveBeenCalled();
    const pre = await worker.fetch(new Request('https://proxy.example/chat', { method: 'OPTIONS', headers: { Origin: 'http://localhost:5180' } }), env);
    expect(pre.status).toBe(204);
    expect(pre.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5180');
    expect(pre.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type');
  });

  it('refuses anything but a well-formed conversation, without calling Gemini', async () => {
    const gemini = vi.fn();
    vi.stubGlobal('fetch', gemini);
    expect((await post('not json')).status).toBe(400);
    expect((await post({ ...chat, turns: [] })).status).toBe(400);
    expect((await post({ ...chat, context: 'x'.repeat(LIMITS.context + 1) })).status).toBe(400);
    expect((await post({ ...chat, turns: [{ role: 'user', text: 'x'.repeat(LIMITS.question + 1) }] })).status).toBe(400);
    expect((await worker.fetch(new Request('https://proxy.example/other', { headers: { Origin: SITE } }), env)).status).toBe(404);
    expect(gemini).not.toHaveBeenCalled();
  });

  it('turns must alternate, starting and ending with the person', () => {
    const q = (text: string) => ({ role: 'user', text }), a = (text: string) => ({ role: 'model', text });
    expect(parseChat({ context: 'c', turns: [q('1'), a('2'), q('3')] })?.turns).toHaveLength(3);
    expect(parseChat({ context: 'c', turns: [q('1'), a('2')] })).toBeNull();
    expect(parseChat({ context: 'c', turns: [a('1')] })).toBeNull();
    expect(parseChat({ context: 'c', turns: [q('1'), q('2'), q('3')] })).toBeNull();
    expect(parseChat({ context: 'c', turns: Array.from({ length: LIMITS.turns + 2 }, (_, i) => (i % 2 ? a('x') : q('x'))) })).toBeNull();
  });

  it('takes the site\'s opening questions, the guide\'s included', () => {
    for (const text of [OPENING_QUESTION, ...Object.values(GOAL_QUESTIONS)]) {
      expect(text.length).toBeLessThanOrEqual(LIMITS.question);
      expect(parseChat({ context: 'c', turns: [{ role: 'user', text }] })).not.toBeNull();
    }
  });

  it('retries a busy Gemini, then says busy; other failures say failed, without Gemini\'s message', async () => {
    vi.useFakeTimers();
    try {
      const busy = vi.fn(async () => new Response('{"error":{"message":"high demand"}}', { status: 503 }));
      vi.stubGlobal('fetch', busy);
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const pending = post(chat);
      await vi.runAllTimersAsync();
      const res = await pending;
      expect(busy).toHaveBeenCalledTimes(3);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'busy' });

      vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"message":"API key not valid"}}', { status: 400 })));
      const bad = await post(chat);
      expect(bad.status).toBe(502);
      expect(await bad.text()).toBe('{"error":"failed"}');
    } finally {
      vi.useRealTimers();
    }
  });

  it('says failed when Gemini sends no visible text, or the key is missing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => sse(say('only thinking', true), { candidates: [{ finishReason: 'MAX_TOKENS' }] })));
    expect(await (await post(chat)).text()).toBe('data: {"error":"failed"}\n\n');
    const noKey = await post(chat, SITE, { ALLOWED_ORIGINS: SITE });
    expect(noKey.status).toBe(503);
  });

  it('applies the rate limit per visitor', async () => {
    const gemini = vi.fn();
    vi.stubGlobal('fetch', gemini);
    const limit = vi.fn(async () => ({ success: false }));
    const res = await post(chat, SITE, { ...env, LIMITER: { limit } });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'limit' });
    expect(gemini).not.toHaveBeenCalled();
  });

  it('reads text from a chunk and ignores the rest', () => {
    expect(chunkText(say('Hi'))).toBe('Hi');
    expect(chunkText(say('hmm', true))).toBe('');
    expect(chunkText({ promptFeedback: { blockReason: 'SAFETY' } })).toBe('');
    expect(chunkText(null)).toBe('');
  });
});
