// The Analysis panel: Gemini's short reading of the current lot, then questions about it. Questions
// go to the Analysis proxy (proxy/gemini, VITE_GEMINI_PROXY), which holds the API key; the
// conversation itself lives here and goes back with each question.
import type { ErrorCode, Turn } from '../../proxy/gemini/worker';
import { copy } from '../copy';
import { formatInsightContext, OPENING_QUESTION, takeEvents, type InsightFacts } from '../insight';

export interface AnalysisChatElements {
  open: HTMLButtonElement;
  panel: HTMLElement;
  close: HTMLButtonElement;
  log: HTMLElement;
  status: HTMLElement;
  form: HTMLFormElement;
  input: HTMLInputElement;
  chips: HTMLElement;
}

/** The last four exchanges go back with each question (the proxy takes nine turns at most). */
const KEEP_TURNS = 8;

/** @param proxy the proxy's base URL, without a trailing slash */
export function initAnalysisChat(proxy: string, els: AnalysisChatElements, getFacts: () => InsightFacts | null) {
  const { open, panel, close, log, status, form, input, chips } = els;
  let turns: Turn[] = [];
  /** The lot the conversation started from; a different one starts it over. */
  let startedWith = '';
  let abort: AbortController | null = null;

  for (const label of copy.analysis.chips) {
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'ghost', textContent: label });
    b.addEventListener('click', () => void ask(label, true));
    chips.append(b);
  }
  open.addEventListener('click', () => (panel.hidden ? show() : hide()));
  close.addEventListener('click', () => {
    hide();
    open.focus();
  });
  panel.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    hide();
    open.focus();
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    void ask(text, true);
  });

  function show() {
    panel.hidden = false;
    open.setAttribute('aria-expanded', 'true');
    panel.scrollIntoView({ block: 'nearest' });
    const facts = getFacts();
    if (!facts) {
      status.textContent = copy.analysis.notReady;
      return;
    }
    const context = formatInsightContext(facts);
    if (context === startedWith && log.childElementCount) return input.focus();
    clear();
    startedWith = context;
    void ask(OPENING_QUESTION, false);
  }

  function hide() {
    panel.hidden = true;
    open.setAttribute('aria-expanded', 'false');
    stop();
  }

  /** Abandon the answer in progress (closing the panel, or starting over). */
  function stop() {
    abort?.abort();
    abort = null;
    setBusy(false);
  }

  function clear() {
    stop();
    turns = [];
    startedWith = '';
    log.replaceChildren();
    status.textContent = '';
  }

  function setBusy(on: boolean) {
    for (const el of form.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button')) el.disabled = on;
    for (const b of chips.querySelectorAll('button')) b.disabled = on;
    status.textContent = on ? copy.analysis.reading : '';
  }

  function bubble(role: 'user' | 'assistant' | 'error', text: string): HTMLParagraphElement {
    const p = Object.assign(document.createElement('p'), { className: 'analysis-msg', textContent: text });
    p.dataset.role = role;
    log.append(p);
    log.scrollTop = log.scrollHeight;
    return p;
  }

  async function ask(question: string, showQuestion: boolean) {
    if (abort) return; // one question at a time
    const facts = getFacts();
    if (!facts) {
      status.textContent = copy.analysis.notReady;
      return;
    }
    if (showQuestion) bubble('user', question);
    const controller = new AbortController();
    abort = controller;
    setBusy(true);
    const reply = bubble('assistant', '');
    let error: ErrorCode | 'offline' | null = null;
    try {
      const res = await fetch(`${proxy}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The newest numbers each time, so a follow-up after changing the dates uses them.
        body: JSON.stringify({ context: formatInsightContext(facts), turns: [...turns, { role: 'user', text: question }] }),
        signal: controller.signal,
      });
      error = res.ok && res.body ? await read(res.body, reply, controller.signal) : await errorOf(res);
      const answer = reply.textContent ?? '';
      if (!error && answer.trim()) turns = [...turns, { role: 'user' as const, text: question }, { role: 'model' as const, text: answer }].slice(-KEEP_TURNS);
      else error ??= 'failed';
    } catch {
      if (!controller.signal.aborted) error = navigator.onLine ? 'failed' : 'offline';
    } finally {
      if (abort === controller) {
        abort = null;
        setBusy(false);
      }
    }
    if (!reply.textContent?.trim()) reply.remove();
    if (error && !controller.signal.aborted) bubble('error', error === 'offline' ? copy.offline : copy.analysis.errors[error]);
    if (!panel.hidden && !controller.signal.aborted) input.focus();
  }

  /** Stream the answer into `reply`; the error code if one arrives or the stream ends without `done`. */
  async function read(body: ReadableStream<Uint8Array>, reply: HTMLElement, signal: AbortSignal): Promise<ErrorCode | null> {
    const reader = body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      buf += dec.decode(value, { stream: !done });
      const taken = takeEvents(done ? `${buf}\n\n` : buf);
      buf = taken.rest;
      for (const e of taken.events) {
        if ('error' in e) return e.error;
        if ('done' in e) return null;
        reply.textContent += e.text;
        status.textContent = '';
        log.scrollTop = log.scrollHeight;
      }
      if (done) break;
    }
    return 'failed';
  }

  async function errorOf(res: Response): Promise<ErrorCode> {
    try {
      const e = ((await res.json()) as { error?: unknown }).error;
      if (e === 'busy' || e === 'limit' || e === 'failed') return e;
    } catch {
      /* not ours: a network page or the like */
    }
    return 'failed';
  }

  /** A new lot or the start page: drop the conversation and close the panel. */
  return {
    reset() {
      clear();
      hide();
    },
  };
}
