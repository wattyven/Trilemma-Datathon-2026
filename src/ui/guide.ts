// The guided start. A first visit to the start page opens a welcome that asks what the visitor is
// here to do; a goal brings up its three steps (address, sun map, advice) with the current one
// highlighted, and "just browsing" leaves the regular page. Whether the welcome has been seen lives
// in localStorage, like the tips card; if storage is blocked it simply shows again next time.
import { copy } from '../copy';
import type { Goal } from '../insight';

const KEY = 'vanshade:welcome-seen-v1';
const GOALS: readonly string[] = ['garden', 'patio', 'home'] satisfies Goal[];

export type Step = 1 | 2 | 3;

export interface GuideElements {
  dialog: HTMLDialogElement;
  section: HTMLElement;
  title: HTMLElement;
  steps: HTMLOListElement;
  exit: HTMLButtonElement;
}

export interface GuideOptions {
  /** Whether there's an advice step (the Analysis chat is set up). */
  advice: boolean;
  /** A choice in the welcome: a goal, or null for "just browsing" (and Escape). */
  onChoose(goal: Goal | null): void;
  /** "Leave the guide": the steps go, the settings stay. */
  onExit(): void;
  /** "Read it" on the advice step. */
  onReadAdvice(): void;
}

function seen(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

function remember() {
  try {
    localStorage.setItem(KEY, '1');
  } catch {
    // Not remembered; harmless.
  }
}

export function initGuide(els: GuideElements, options: GuideOptions) {
  const { dialog, section, title, steps, exit } = els;
  let goal: Goal | null = null;
  let step: Step = 1;

  dialog.addEventListener('close', () => {
    const v = dialog.returnValue;
    goal = GOALS.includes(v) ? (v as Goal) : null;
    step = 1;
    render();
    options.onChoose(goal);
  });
  // Click on the backdrop closes it, like Escape does: just browsing.
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });
  exit.addEventListener('click', () => {
    goal = null;
    render();
    options.onExit();
  });

  function render() {
    document.documentElement.classList.toggle('guided', goal !== null);
    section.hidden = goal === null;
    if (!goal) return steps.replaceChildren();
    const g = copy.guide.goals[goal];
    title.textContent = g.title;
    const shown = options.advice ? g.steps : g.steps.slice(0, 2);
    steps.replaceChildren(
      ...shown.map((s, i) => {
        const n = i + 1;
        const state = n < step ? 'done' : n === step ? 'current' : 'todo';
        const li = document.createElement('li');
        li.dataset.state = state;
        if (state === 'current') li.setAttribute('aria-current', 'step');
        const num = Object.assign(document.createElement('span'), { className: 'guide-n', textContent: state === 'done' ? '✓' : String(n) });
        num.setAttribute('aria-hidden', 'true');
        const body = Object.assign(document.createElement('div'), { className: 'guide-body' });
        const head = document.createElement('strong');
        if (state === 'done') head.append(Object.assign(document.createElement('span'), { className: 'visually-hidden', textContent: copy.guide.done }));
        head.append(s.title);
        body.append(head, Object.assign(document.createElement('span'), { className: 'guide-text', textContent: s.text }));
        if (n === 3 && state === 'current') {
          const read = Object.assign(document.createElement('button'), { type: 'button', className: 'link', textContent: copy.guide.read });
          read.addEventListener('click', () => options.onReadAdvice());
          body.append(read);
        }
        li.append(num, body);
        return li;
      }),
    );
  }

  function openWelcome() {
    remember(); // once shown, it's been seen (the start page's link brings it back)
    dialog.returnValue = '';
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', ''); // very old browsers: show inline
  }

  return {
    /** The visitor's goal while the guide is on. */
    get goal(): Goal | null {
      return goal;
    },
    /** Highlight a step (1: address, 2: the sun map, 3: the advice). */
    setStep(n: Step) {
      if (n === step) return;
      step = n;
      if (goal) render();
    },
    openWelcome,
    /** On the start page: the welcome, unless this visitor has seen it before. */
    showFirstTime() {
      if (!seen()) openWelcome();
    },
  };
}
