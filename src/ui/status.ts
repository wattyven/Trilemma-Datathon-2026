// Progress shown in plain words: Finding address → Finding the lot → …
import { copy } from '../copy';

export type StepId = keyof typeof copy.steps;
export type StepState = 'pending' | 'active' | 'done' | 'error';

export interface Steps {
  set(id: StepId, state: StepState): void;
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
    set(id, state) {
      const li = items.get(id);
      if (!li) return;
      li.dataset.state = state;
      if (state === 'active') li.setAttribute('aria-current', 'step');
      else li.removeAttribute('aria-current');
    },
    hide() {
      list.hidden = true;
      list.replaceChildren();
    },
  };
}
