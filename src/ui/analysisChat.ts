// The Analysis panel: a reading of the current lot, then questions about that same reading.
// It sits in the info column under the lot notice, so it never covers the 3D view.
import { copy } from '../copy';
import { GeminiChatError, streamGemini, type GeminiTurn } from '../geminiDirect';
import { advisorInstructions, formatInsightContext, type InsightFacts } from '../insight';

export interface AnalysisChatElements {
  open: HTMLButtonElement;
  panel: HTMLElement;
  log: HTMLElement;
  status: HTMLElement;
  form: HTMLFormElement;
  input: HTMLInputElement;
  chips: HTMLElement;
}

type ChatCode = 'failed' | 'no-server' | 'no-key' | 'no-repo' | 'busy';

/** Chat id. `randomUUID` is missing in an insecure frame, and that throw used to stop the map from loading. */
function newSessionId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

interface StreamEvent {
  text?: string;
  status?: 'starting' | 'reading' | 'working';
  code?: ChatCode;
  detail?: string;
  done?: boolean;
}

export function initAnalysisChat(
  els: AnalysisChatElements,
  getFacts: () => InsightFacts | null,
  prepare?: () => Promise<void>,
) {
  const { open, panel, log, status, form, input, chips } = els;
  const closeBtn = panel.querySelector<HTMLButtonElement>('#analysis-close');
  const browserKey = import.meta.env.VITE_GEMINI_API_KEY?.trim() ?? '';
  let sessionId = newSessionId();
  let turns: GeminiTurn[] = [];
  let shownContext = '';
  let abort: AbortController | null = null;
  let busy = false;
  /** Bumped when a conversation is thrown away, so a late reply can't re-enable the form. */
  let generation = 0;

  for (const label of copy.analysis.chips) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ghost';
    btn.textContent = label;
    btn.addEventListener('click', () => void ask(label, true));
    chips.append(btn);
  }

  open.addEventListener('click', () => {
    if (!panel.hidden) {
      hide();
      return;
    }
    void show();
  });
  closeBtn?.addEventListener('click', () => hide());
  panel.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    ev.stopPropagation();
    hide();
    open.focus();
  });
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    void ask(text, true);
  });

  function reveal() {
    panel.hidden = false;
    open.setAttribute('aria-expanded', 'true');
    panel.scrollIntoView({ block: 'nearest' });
  }

  function hide() {
    panel.hidden = true;
    open.setAttribute('aria-expanded', 'false');
    abort?.abort();
    abort = null;
    setBusy(false);
    status.textContent = '';
  }

  async function show() {
    const gen = generation;
    reveal();
    if (prepare) {
      status.textContent = copy.analysis.playing;
      try {
        await prepare();
      } catch {
        /* the day view can fail; still read whatever result is on screen */
      }
      if (gen !== generation) return;
    }
    const facts = getFacts();
    if (!facts) {
      status.textContent = copy.analysis.empty;
      return;
    }
    const context = formatInsightContext(facts);
    if (context === shownContext && log.childElementCount > 0) {
      input.focus();
      return;
    }
    const previous = sessionId;
    generation++;
    abort?.abort();
    abort = null;
    setBusy(false);
    sessionId = newSessionId();
    turns = [];
    shownContext = context;
    log.replaceChildren();
    void closeSession(previous);
    void ask(copy.analysis.opening, false);
  }

  /** A new search: drop the conversation and the cloud agent behind it. */
  function reset() {
    const previous = sessionId;
    generation++;
    shownContext = '';
    abort?.abort();
    abort = null;
    setBusy(false);
    sessionId = newSessionId();
    turns = [];
    hide();
    log.replaceChildren();
    status.textContent = '';
    void closeSession(previous);
  }

  function setBusy(on: boolean) {
    busy = on;
    input.disabled = on;
    form.querySelector('button')!.disabled = on;
    for (const btn of chips.querySelectorAll('button')) btn.disabled = on;
  }

  function bubble(role: 'user' | 'assistant' | 'error', text: string): HTMLParagraphElement {
    const p = document.createElement('p');
    p.className = 'analysis-msg';
    p.dataset.role = role;
    p.textContent = text;
    log.append(p);
    log.scrollTop = log.scrollHeight;
    return p;
  }

  async function ask(message: string, showUser: boolean) {
    if (busy) return;
    const gen = generation;
    const facts = getFacts();
    if (!facts) {
      status.textContent = copy.analysis.empty;
      return;
    }
    if (showUser) bubble('user', message);
    setBusy(true);
    status.textContent = copy.analysis.reading;
    abort?.abort();
    const controller = new AbortController();
    abort = controller;
    const reply = bubble('assistant', '');
    try {
      if (browserKey) {
        const text = await streamGemini({
          key: browserKey,
          instructions: advisorInstructions(formatInsightContext(facts)),
          turns,
          message,
          signal: controller.signal,
          onText: (extra) => {
            reply.textContent += extra;
            log.scrollTop = log.scrollHeight;
            status.textContent = '';
          },
        });
        if (text.trim()) {
          turns.push({ role: 'user', text: message }, { role: 'model', text });
          while (turns.length > 8) turns.splice(0, 2);
        } else {
          reply.remove();
          bubble('error', copy.analysis.failed);
        }
        return;
      }
      const res = await fetch('/api/analysis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, context: formatInsightContext(facts), message }),
        signal: controller.signal,
      });
      const type = res.headers.get('content-type') ?? '';
      if (!res.body || !type.includes('text/event-stream')) {
        reply.remove();
        bubble('error', res.status === 404 || type.includes('text/html') ? copy.analysis.noServer : await errorText(res));
        return;
      }
      await readStream(res.body, reply, controller.signal);
      const code = reply.dataset.error as ChatCode | undefined;
      const detail = reply.dataset.detail ?? '';
      if (!reply.textContent?.trim()) reply.remove();
      if (code) bubble('error', code === 'failed' && detail ? detail : messageFor(code));
      else if (!reply.isConnected) bubble('error', copy.analysis.failed);
    } catch (e) {
      if (e instanceof GeminiChatError) {
        reply.remove();
        bubble('error', e.code === 'failed' && e.detail ? e.detail : messageFor(e.code));
        return;
      }
      if ((e as { name?: string }).name === 'AbortError') {
        if (!reply.textContent) reply.remove();
        return;
      }
      reply.remove();
      bubble('error', navigator.onLine ? copy.analysis.failed : copy.offline);
    } finally {
      if (gen !== generation) return;
      if (abort === controller) abort = null;
      setBusy(false);
      status.textContent = '';
      if (!panel.hidden) input.focus();
    }
  }

  async function readStream(body: ReadableStream<Uint8Array>, reply: HTMLParagraphElement, signal: AbortSignal) {
    const reader = body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (value) buf += dec.decode(value, { stream: !done });
      let idx = buf.indexOf('\n\n');
      while (idx >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = block.split('\n').find((l) => l.startsWith('data:'));
        if (line) {
          try {
            applyEvent(JSON.parse(line.slice(5).trim()) as StreamEvent, reply);
          } catch {
            /* a partial or non-JSON keepalive */
          }
        }
        idx = buf.indexOf('\n\n');
      }
      if (done) break;
    }
  }

  function applyEvent(ev: StreamEvent, reply: HTMLParagraphElement) {
    if (ev.status === 'starting') status.textContent = copy.analysis.starting;
    else if (ev.status === 'reading') status.textContent = copy.analysis.reading;
    else if (ev.status === 'working') status.textContent = copy.analysis.working;
    if (ev.text) {
      reply.textContent += ev.text;
      log.scrollTop = log.scrollHeight;
      status.textContent = '';
    }
    if (ev.code) reply.dataset.error = ev.code;
    if (ev.detail) reply.dataset.detail = ev.detail;
  }

  async function errorText(res: Response): Promise<string> {
    if (res.status === 404) return copy.analysis.noServer;
    try {
      const body = (await res.json()) as { code?: ChatCode; detail?: string };
      if (body.code === 'failed' && body.detail) return body.detail;
      if (body.code) return messageFor(body.code);
    } catch {
      /* not JSON */
    }
    return copy.analysis.failed;
  }

  function messageFor(code: ChatCode): string {
    switch (code) {
      case 'no-server':
        return copy.analysis.noServer;
      case 'no-key':
        return copy.analysis.noKey;
      case 'no-repo':
        return copy.analysis.noRepo;
      case 'busy':
        return copy.analysis.busy;
      case 'failed':
        return copy.analysis.failed;
      default: {
        const _never: never = code;
        return _never;
      }
    }
  }

  async function closeSession(id: string) {
    if (browserKey) return;
    try {
      await fetch('/api/analysis/close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: id }),
        keepalive: true,
      });
    } catch {
      /* the dev server may not be the one serving this page */
    }
  }

  return { reset };
}
