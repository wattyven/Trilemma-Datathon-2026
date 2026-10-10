// The Analysis panel, under the view whenever a lot has a result: Gemini's short reading of the lot,
// then questions about it. Questions go to the Analysis proxy (proxy/gemini, VITE_GEMINI_PROXY),
// which holds the API key; the conversation itself lives here and goes back with each question.
import type { ErrorCode, Turn } from '../../proxy/gemini/worker';
import { copy } from '../copy';
import { formatInsightContext, takeEvents, type InsightFacts } from '../insight';

export interface AnalysisChatElements {
  panel: HTMLElement;
  /** Takes focus when the guide brings the panel into view (tabindex="-1"). */
  heading: HTMLElement;
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
  const { panel, heading, log, status, form, input, chips } = els;
  let turns: Turn[] = [];
  /** This lot's reading has been asked for (once per lot). */
  let readAsked = false;
  let abort: AbortController | null = null;

  for (const label of copy.analysis.chips) {
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'ghost', textContent: label });
    b.addEventListener('click', () => void ask(label, true));
    chips.append(b);
  }
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    void ask(text, true);
  });

  /** Abandon the answer in progress (a new lot, or the start page). */
  function stop() {
    abort?.abort();
    abort = null;
    setBusy(false);
  }

  function clear() {
    stop();
    turns = [];
    readAsked = false;
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

  async function ask(question: string, showQuestion: boolean, focusAfter = true) {
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
      error = res.ok && res.body ? await stream(res.body, reply, controller.signal) : await errorOf(res);
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
    if (focusAfter && !panel.hidden && !controller.signal.aborted) input.focus();
  }

  /** Stream the answer into `reply`; the error code if one arrives or the stream ends without `done`. */
  async function stream(body: ReadableStream<Uint8Array>, reply: HTMLElement, signal: AbortSignal): Promise<ErrorCode | null> {
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

  return {
    /** A new lot or the start page: drop the conversation and hide the panel. */
    reset() {
      clear();
      panel.hidden = true;
    },
    /** A result is on screen: the panel shows, "Reading this lot…" until the reading starts. */
    show() {
      if (!panel.hidden) return;
      panel.hidden = false;
      if (!readAsked) setBusy(true);
    },
    /** Read the lot with this (unshown) first question, once per lot; focus stays where it is. */
    read(opening: string) {
      if (readAsked || panel.hidden) return;
      readAsked = true;
      setBusy(false);
      void ask(opening, false, false);
    },
    /** Bring the panel into view and move focus to it. */
    reveal() {
      const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
      panel.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
      heading.focus({ preventScroll: true });
    },
  };
}
