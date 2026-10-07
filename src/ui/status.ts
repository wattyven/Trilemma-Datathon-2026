// Progress shown in plain words: Finding address → Finding the lot → …
import { copy } from '../copy';

export type StepId = keyof typeof copy.steps;
export type StepState = 'pending' | 'active' | 'done' | 'error';

export interface Steps {
  /** `label` replaces the step's text (e.g. a progress percentage); omit it to restore the default. */
  set(id: StepId, state: StepState, label?: string): void;
  /** Mark whichever step is in progress as failed. */
  failActive(): void;
  hide(): void;
}

export function showSteps(list: HTMLOListElement, ids: StepId[]): Steps {
  const items = new Map<StepId, HTMLLIElement>();
  list.replaceChildren(
    ...ids.map((id) => {
      const li = document.createElement('li');
      li.textContent = copy.steps[id];
      li.dataset.state = 'pending';
      items.set(id, li);
      return li;
    }),
  );
  list.hidden = false;
  return {
    set(id, state, label) {
      const li = items.get(id);
      if (!li) return;
      li.dataset.state = state;
      li.textContent = label ?? copy.steps[id];
      if (state === 'active') li.setAttribute('aria-current', 'step');
      else li.removeAttribute('aria-current');
    },
    failActive() {
      for (const [id, li] of items) if (li.dataset.state === 'active') this.set(id, 'error');
    },
    hide() {
      list.hidden = true;
      list.replaceChildren();
    },
  };
}
