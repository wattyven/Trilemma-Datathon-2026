// Progress shown in plain words: Finding address → Finding the lot → …
import { copy } from '../copy';

export type StepId = keyof typeof copy.steps;
export type StepState = 'pending' | 'active' | 'done' | 'error';

export interface Steps {
  /** `label` replaces the step's text (e.g. a progress percentage); omit it to restore the default. */
  set(id: StepId, state: StepState, label?: string): void;
  /** Add a step at the end, or take one away (the aerial photos, once the municipality is known). */
  add(id: StepId): void;
  remove(id: StepId): void;
  /** Show a list made with `visible: false`; does nothing once hidden. */
  show(): void;
  /** Mark whichever step is in progress as failed. */
  failActive(): void;
  hide(): void;
}

export function showSteps(list: HTMLOListElement, ids: StepId[], { visible = true } = {}): Steps {
  const items = new Map<StepId, HTMLLIElement>();
  let over = false;
  const item = (id: StepId) => {
    const li = document.createElement('li');
    li.textContent = copy.steps[id];
    li.dataset.state = 'pending';
    items.set(id, li);
    return li;
  };
  const note = Object.assign(document.createElement('li'), { className: 'note', textContent: copy.stepsNote });
  list.replaceChildren(...ids.map(item), note);
  list.hidden = !visible;
  return {
    add(id) {
      if (!items.has(id)) note.before(item(id));
    },
    remove(id) {
      items.get(id)?.remove();
      items.delete(id);
    },
    show() {
      if (!over) list.hidden = false;
    },
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
      over = true;
      list.hidden = true;
      list.replaceChildren();
    },
  };
}
