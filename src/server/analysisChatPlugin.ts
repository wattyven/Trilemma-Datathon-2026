// Dev-server side of the Analysis chat. Keys are read from .env.local and never sent to the browser.
// Gemini answers directly. Cursor is only used when no Gemini key is saved, as a no-repo cloud agent.
import { loadEnv, type Plugin } from 'vite';
import { advisorInstructions, buildAdvisorPrompt, explainAdvisorFailure, geminiPayloadText, mergeAssistantText, takeSseEvents, takeSseEventsEnd } from '../insight';

const API = 'https://api.cursor.com';
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse';
const IDLE_MS = 10 * 60 * 1000;

type Code = 'no-key' | 'no-repo' | 'busy' | 'failed';

class AdvisorError extends Error {
  constructor(readonly code: Code, readonly detail = '') {
    super(detail || code);
  }
}

interface GeminiTurn {
  role: 'user' | 'model';
  text: string;
}

interface GeminiChat {
  turns: GeminiTurn[];
  touched: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

const geminiChats = new Map<string, GeminiChat>();

interface Session {
  id: string;
  agentId: string | null;
  touched: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  stop: AbortController | null;
}

const sessions = new Map<string, Session>();
const queues = new Map<string, Promise<unknown>>();
let announced = false;

export function analysisChatPlugin(): Plugin {
  return {
    name: 'vanshade-analysis-chat',
    configureServer(server) {
      attach(asMiddleware(server.middlewares), server.config.root, server.config.mode);
    },
    configurePreviewServer(server) {
      attach(asMiddleware(server.middlewares), server.config.root, server.config.mode);
    },
  };
}

/** Vite's request type comes from Node, which this browser project does not include. The running server still has `url` and `method`. */
function asMiddleware(middlewares: object): { use(fn: (req: IncomingRequest, res: ServerResponse, next: () => void) => void): void } {
  return middlewares as { use(fn: (req: IncomingRequest, res: ServerResponse, next: () => void) => void): void };
}

function attach(middlewares: { use(fn: (req: IncomingRequest, res: ServerResponse, next: () => void) => void): void }, root: string, mode: string) {
  middlewares.use((req, res, next) => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== '/api/analysis' && path !== '/api/analysis/close') {
      next();
      return;
    }
    if (req.method !== 'POST') {
      json(res, 405, 'failed');
      return;
    }
    void handle(req, res, path, { cursor: cursorKey(root, mode), gemini: geminiKey(root, mode) }).catch((err) => {
      if ((err as { name?: string }).name === 'AbortError') {
        if (!res.writableEnded) res.end();
        return;
      }
      const code: Code = err instanceof AdvisorError ? err.code : 'failed';
      const detail = err instanceof AdvisorError ? err.detail : '';
      if (!(err instanceof AdvisorError)) console.error('[analysis]', err instanceof Error ? err.message : err);
      if (!res.headersSent) json(res, statusFor(code), code, detail);
      else if (!res.writableEnded) {
        writeEvent(res, detail ? { code, detail } : { code });
        res.end();
      }
    });
  });
}

function savedKey(root: string, mode: string, name: string): string {
  const env = loadEnv(mode, root, '');
  const fromProcess = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
  return (fromProcess ?? env[name] ?? '').trim();
}

function cursorKey(root: string, mode: string): string {
  return savedKey(root, mode, 'CURSOR_API_KEY');
}

function geminiKey(root: string, mode: string): string {
  return savedKey(root, mode, 'GEMINI_API_KEY');
}

function endGemini(id: string) {
  const chat = geminiChats.get(id);
  if (!chat) return;
  clearTimeout(chat.timer);
  geminiChats.delete(id);
}

function touchGemini(id: string): GeminiChat {
  let chat = geminiChats.get(id);
  if (!chat) {
    chat = { turns: [], touched: 0, timer: undefined };
    geminiChats.set(id, chat);
    while (geminiChats.size > 6) {
      const oldest = [...geminiChats.entries()].sort((a, b) => a[1].touched - b[1].touched)[0];
      if (!oldest || oldest[0] === id) break;
      endGemini(oldest[0]);
    }
  }
  chat.touched = Date.now();
  clearTimeout(chat.timer);
  chat.timer = setTimeout(() => endGemini(id), IDLE_MS);
  return chat;
}

async function answerWithGemini(
  res: ServerResponse,
  body: { sessionId: string; context: string; message: string },
  key: string,
) {
  const stop = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) stop.abort();
  });
  sse(res);
  writeEvent(res, { status: 'reading' });
  await gate(body.sessionId, async () => {
    const chat = touchGemini(body.sessionId);
    const contents: { role: 'user' | 'model'; parts: { text: string }[] }[] = [
      ...chat.turns.map((turn) => ({ role: turn.role, parts: [{ text: turn.text }] })),
      { role: 'user' as const, parts: [{ text: body.message }] },
    ];
    const instructions = advisorInstructions(body.context);
    let response = await geminiStream(key, instructions, contents, true, stop.signal);
    if (!response.ok || !response.body) throw await geminiFailure(response);
    let soFar = await readGeminiReply(response, (extra) => writeEvent(res, { text: extra }), stop.signal);
    // A thinking-only reply has no visible text. Ask once more with thinking turned off.
    if (!soFar.trim() && !stop.signal.aborted) {
      response = await geminiStream(key, instructions, contents, false, stop.signal);
      if (!response.ok || !response.body) throw await geminiFailure(response);
      soFar = await readGeminiReply(response, (extra) => writeEvent(res, { text: extra }), stop.signal);
    }
    if (!soFar.trim()) {
      if (!stop.signal.aborted) writeEvent(res, { code: 'failed', detail: 'Gemini returned no reply text.' });
    } else if (!stop.signal.aborted) {
      chat.turns.push({ role: 'user', text: body.message }, { role: 'model', text: soFar });
      while (chat.turns.length > 8) chat.turns.splice(0, 2);
      writeEvent(res, { done: true });
    }
    res.end();
  });
}

async function readGeminiReply(response: Response, onText: (extra: string) => void, signal: AbortSignal): Promise<string> {
  const reader = response.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let raw = '';
  let soFar = '';
  const pushData = (data: string) => {
    const merged = mergeAssistantText(soFar, geminiPayloadText(data));
    const extra = merged.slice(soFar.length);
    soFar = merged;
    if (extra) onText(extra);
  };
  const take = (events: { data: string }[]) => {
    for (const ev of events) if (ev.data && ev.data !== '[DONE]') pushData(ev.data);
  };
  while (!signal.aborted) {
    const { done, value } = await reader.read();
    if (value) {
      const chunk = dec.decode(value, { stream: !done });
      buf += chunk;
      raw += chunk;
    }
    if (done) {
      take(takeSseEventsEnd(buf).events);
      break;
    }
    const taken = takeSseEvents(buf);
    buf = taken.rest;
    take(taken.events);
  }
  if (!soFar.trim() && raw.trim()) pushData(raw);
  return soFar;
}

async function geminiStream(
  key: string,
  instructions: string,
  contents: { role: 'user' | 'model'; parts: { text: string }[] }[],
  allowThinking: boolean,
  signal: AbortSignal,
): Promise<Response> {
  const generationConfig: { maxOutputTokens: number; thinkingConfig?: { thinkingLevel: string } } = {
    maxOutputTokens: 800,
  };
  if (allowThinking) generationConfig.thinkingConfig = { thinkingLevel: 'low' };
  const post = () => fetch(GEMINI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: instructions }] },
      contents,
      generationConfig,
    }),
    signal,
  });
  let first = await post();
  // 503 is Gemini's "high demand" spike. A short wait usually clears it.
  for (let attempt = 0; attempt < 2 && (first.status === 429 || first.status === 503); attempt++) {
    await first.body?.cancel().catch(() => undefined);
    await delay(1000 * (attempt + 1), signal);
    first = await post();
  }
  if (first.status !== 400) return first;
  const text = await first.text();
  if (!/thinking/i.test(text)) return new Response(text, { status: first.status, headers: first.headers });
  delete generationConfig.thinkingConfig;
  return post();
}

async function geminiFailure(res: Response): Promise<AdvisorError> {
  const text = await res.text();
  console.error('[analysis] Gemini', res.status, text.slice(0, 300));
  if (res.status === 401 || res.status === 403) return new AdvisorError('no-key');
  if (res.status === 429 || res.status === 503) return new AdvisorError('busy');
  return failureFrom(text);
}

async function handle(req: IncomingRequest, res: ServerResponse, path: string, keys: { cursor: string; gemini: string }) {
  let raw: unknown;
  try {
    raw = JSON.parse(await readBody(req)) as unknown;
  } catch (e) {
    if (e instanceof AdvisorError) throw e;
    return json(res, 400, 'failed');
  }
  if (path === '/api/analysis/close') {
    const id = sessionIdOf(raw);
    if (!id) return json(res, 400, 'failed');
    endGemini(id);
    await endSession(id, keys.cursor);
    res.statusCode = 204;
    res.end();
    return;
  }
  const body = chatBody(raw);
  if (!body) return json(res, 400, 'failed');
  if (keys.gemini) {
    await answerWithGemini(res, body, keys.gemini);
    return;
  }
  if (!keys.cursor) return json(res, 503, 'no-key');
  void announce(keys.cursor);

  const stop = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) stop.abort();
  });
  sse(res);
  writeEvent(res, { status: 'starting' });
  await gate(body.sessionId, async () => {
    const session = touch(body.sessionId, keys.cursor);
    session.stop?.abort();
    session.stop = stop;
    const prompt = buildAdvisorPrompt(body.context, body.message);
    const run = await startRun(session, keys.cursor, prompt, stop.signal);
    writeEvent(res, { status: 'reading' });
    await pipeRun(run.agentId, run.runId, keys.cursor, (obj) => writeEvent(res, obj), stop.signal);
  });
  if (!res.writableEnded) {
    writeEvent(res, { done: true });
    res.end();
  }
}

function chatBody(raw: unknown): { sessionId: string; context: string; message: string } | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const sessionId = sessionIdOf(raw);
  if (!sessionId || typeof o.context !== 'string' || o.context.length > 8000) return null;
  if (typeof o.message !== 'string' || !o.message.trim() || o.message.length > 2000) return null;
  return { sessionId, context: o.context, message: o.message.trim() };
}

function sessionIdOf(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const id = (raw as { sessionId?: unknown }).sessionId;
  return typeof id === 'string' && /^[A-Za-z0-9-]{8,80}$/.test(id) ? id : null;
}

function gate<T>(id: string, job: () => Promise<T>): Promise<T> {
  const prev = queues.get(id) ?? Promise.resolve();
  const run = prev.then(job, job);
  queues.set(id, run.then(() => undefined, () => undefined));
  return run;
}

function touch(id: string, key: string): Session {
  let session = sessions.get(id);
  if (!session) {
    session = { id, agentId: null, touched: 0, timer: undefined, stop: null };
    sessions.set(id, session);
    while (sessions.size > 6) {
      const oldest = [...sessions.values()].sort((a, b) => a.touched - b.touched)[0];
      if (!oldest || oldest.id === id) break;
      void endSession(oldest.id, key);
    }
  }
  session.touched = Date.now();
  clearTimeout(session.timer);
  session.timer = setTimeout(() => void endSession(id, key), IDLE_MS);
  return session;
}

async function endSession(id: string, key: string) {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  clearTimeout(session.timer);
  session.stop?.abort();
  if (session.agentId && key) await removeAgent(session.agentId, key);
}

async function startRun(session: Session, key: string, prompt: string, signal: AbortSignal): Promise<{ agentId: string; runId: string }> {
  if (session.agentId) {
    try {
      const runId = await followUp(session.agentId, key, prompt, signal);
      return { agentId: session.agentId, runId };
    } catch (e) {
      if (!(e instanceof AdvisorError) || (e.code !== 'failed' && e.code !== 'no-repo')) throw e;
      await removeAgent(session.agentId, key);
      session.agentId = null;
    }
  }
  const created = await createAgent(key, prompt, signal);
  session.agentId = created.agentId;
  return created;
}

async function createAgent(key: string, prompt: string, signal: AbortSignal): Promise<{ agentId: string; runId: string }> {
  const res = await fetch(`${API}/v1/agents`, {
    method: 'POST',
    headers: auth(key),
    body: JSON.stringify({ name: 'VanShade analysis', prompt: { text: prompt }, mode: 'agent' }),
    signal,
  });
  if (!res.ok) throw await cursorFailure(res);
  const body = (await res.json()) as { agent?: { id?: string }; run?: { id?: string } };
  if (!body.agent?.id || !body.run?.id || !safeId(body.agent.id) || !safeId(body.run.id)) throw new AdvisorError('failed');
  return { agentId: body.agent.id, runId: body.run.id };
}

async function followUp(agentId: string, key: string, prompt: string, signal: AbortSignal): Promise<string> {
  const res = await fetch(`${API}/v1/agents/${encodeURIComponent(agentId)}/runs`, {
    method: 'POST',
    headers: auth(key),
    body: JSON.stringify({ prompt: { text: prompt } }),
    signal,
  });
  if (!res.ok) throw await cursorFailure(res);
  const body = (await res.json()) as { run?: { id?: string } };
  if (!body.run?.id || !safeId(body.run.id)) throw new AdvisorError('failed');
  return body.run.id;
}

async function pipeRun(agentId: string, runId: string, key: string, send: (obj: object) => void, signal: AbortSignal) {
  let res: Response;
  try {
    res = await fetch(`${API}/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/stream`, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'text/event-stream' },
      signal,
    });
  } catch (e) {
    if ((e as { name?: string }).name === 'AbortError') throw e;
    await pollRun(agentId, runId, key, send, signal);
    return;
  }
  if (!res.ok || !res.body) {
    await pollRun(agentId, runId, key, send, signal);
    return;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let soFar = '';
  let problem: AdvisorError | null = null;
  const push = (next: string) => {
    const merged = mergeAssistantText(soFar, next);
    const extra = merged.slice(soFar.length);
    soFar = merged;
    if (extra) send({ text: extra });
  };
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (value) buf += dec.decode(value, { stream: !done });
      const taken = takeSseEvents(buf);
      buf = taken.rest;
      for (const ev of taken.events) {
        let data: { text?: string; result?: string; status?: string; message?: string } = {};
        if (ev.data) {
          try {
            data = JSON.parse(ev.data) as { text?: string; result?: string; status?: string; message?: string };
          } catch {
            continue;
          }
        }
        const text = data.text || data.result || '';
        if (ev.event === 'status' && data.status === 'CREATING') send({ status: 'starting' });
        else if (ev.event === 'status' && data.status === 'RUNNING') send({ status: 'reading' });
        else if (ev.event === 'tool_call') send({ status: 'working' });
        else if (ev.event === 'assistant' && text) push(text);
        else if (ev.event === 'result') {
          if (text) push(text);
          if (data.status && data.status !== 'FINISHED' && !soFar.trim()) problem = failureFrom(data.message || `Run ended ${data.status}`);
        } else if (ev.event === 'error' && !soFar.trim()) problem = failureFrom(data.message || '');
      }
      if (done) break;
    }
  } finally {
    if (signal.aborted) await cancelRun(agentId, runId, key);
  }
  // The stream often closes while the cloud agent is still starting. The finished reply is on the run.
  if (!soFar.trim() && !signal.aborted) {
    try {
      await pollRun(agentId, runId, key, (obj) => {
        send(obj);
        const text = (obj as { text?: unknown }).text;
        if (typeof text === 'string' && text.trim()) soFar = mergeAssistantText(soFar, text);
      }, signal);
    } catch (e) {
      if (problem) throw problem;
      throw e;
    }
  }
  if (!soFar.trim() && problem) throw problem;
}

async function pollRun(agentId: string, runId: string, key: string, send: (obj: object) => void, signal: AbortSignal) {
  const terminal = new Set(['FINISHED', 'ERROR', 'CANCELLED', 'EXPIRED']);
  for (let i = 0; i < 90 && !signal.aborted; i++) {
    await delay(2000, signal);
    const res = await fetch(`${API}/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}`, {
      headers: auth(key),
      signal,
    });
    if (!res.ok) throw await cursorFailure(res);
    const run = (await res.json()) as { status?: string; result?: string };
    if (run.status && terminal.has(run.status)) {
      if (run.result) send({ text: run.result });
      if (run.status !== 'FINISHED' && !run.result?.trim()) throw failureFrom(`Run ended ${run.status}`);
      return;
    }
  }
  if (!signal.aborted) throw failureFrom('');
}

async function cancelRun(agentId: string, runId: string, key: string) {
  await fetch(`${API}/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/cancel`, {
    method: 'POST',
    headers: auth(key),
  }).catch(() => undefined);
}

async function removeAgent(agentId: string, key: string) {
  await fetch(`${API}/v1/agents/${encodeURIComponent(agentId)}`, { method: 'DELETE', headers: auth(key) }).catch(() => undefined);
}

async function announce(key: string) {
  if (announced) return;
  announced = true;
  try {
    const res = await fetch(`${API}/v1/me`, { headers: auth(key) });
    if (!res.ok) return;
    const me = (await res.json()) as { apiKeyName?: string };
    if (me.apiKeyName) console.log(`[analysis] Cursor key: ${me.apiKeyName}`);
  } catch {
    /* the chat request reports a real failure */
  }
}

function failureFrom(message: string): AdvisorError {
  const problem = explainAdvisorFailure(message);
  return new AdvisorError(problem.code, problem.detail);
}

async function cursorFailure(res: Response): Promise<AdvisorError> {
  const text = await res.text();
  console.error('[analysis] Cursor', res.status, text.slice(0, 400));
  if (res.status === 401 || res.status === 403) return new AdvisorError('no-key');
  if (res.status === 409) return new AdvisorError('busy');
  return failureFrom(text);
}

function auth(key: string): Record<string, string> {
  return { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
}

function safeId(id: string): boolean {
  return /^[A-Za-z0-9_-]{4,80}$/.test(id);
}

function sse(res: ServerResponse) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
}

function writeEvent(res: ServerResponse, obj: object) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function json(res: ServerResponse, status: number, code: Code, detail = '') {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(detail ? { code, detail } : { code }));
}

function statusFor(code: Code): number {
  switch (code) {
    case 'no-key':
      return 503;
    case 'busy':
      return 429;
    case 'no-repo':
    case 'failed':
      return 502;
    default: {
      const _never: never = code;
      return _never;
    }
  }
}

async function readBody(req: IncomingRequest): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Uint8Array | string>) {
    const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
    size += bytes.byteLength;
    if (size > 32_000) throw new AdvisorError('failed');
    chunks.push(bytes);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('aborted', 'AbortError'));
    }, { once: true });
  });
}

/** The fields the middleware uses. Typed locally so this file does not depend on Node's type package. */
interface IncomingRequest {
  url?: string;
  method?: string;
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array | string>;
}

interface ServerResponse {
  statusCode: number;
  headersSent: boolean;
  writableEnded: boolean;
  writableFinished: boolean;
  setHeader(name: string, value: string): void;
  write(chunk: string): void;
  end(chunk?: string): void;
  on(event: 'close', cb: () => void): void;
}
