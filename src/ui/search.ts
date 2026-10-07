// Address search box: a WAI-ARIA 1.2 combobox with a debounced suggestion list.
import { AUTOCOMPLETE } from '../config';
import type { GeocodeMatch } from '../data/geocoder';
import { isAbortError } from '../data/http';

export interface SearchHandlers {
  fetchSuggestions(query: string, signal: AbortSignal): Promise<GeocodeMatch[]>;
  onPick(match: GeocodeMatch): void;
  onSubmitText(text: string): void;
}

export interface SearchControl {
  setValue(text: string): void;
  close(): void;
}

export function initSearch(form: HTMLFormElement, input: HTMLInputElement, listbox: HTMLUListElement, h: SearchHandlers): SearchControl {
  let options: GeocodeMatch[] = [];
  let active = -1;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | null = null;

  const optionId = (i: number) => `${listbox.id}-${i}`;

  function render() {
    listbox.replaceChildren(
      ...options.map((m, i) => {
        const li = document.createElement('li');
        li.id = optionId(i);
        li.setAttribute('role', 'option');
        li.textContent = m.fullAddress;
        li.setAttribute('aria-selected', String(i === active));
        // mousedown, not click, so the input keeps focus and doesn't close the list first.
        li.addEventListener('mousedown', (ev) => {
          ev.preventDefault();
          pick(i);
        });
        return li;
      }),
    );
    const open = options.length > 0;
    listbox.hidden = !open;
    input.setAttribute('aria-expanded', String(open));
    if (active >= 0) input.setAttribute('aria-activedescendant', optionId(active));
    else input.removeAttribute('aria-activedescendant');
  }

  function close() {
    controller?.abort();
    controller = null;
    clearTimeout(timer);
    options = [];
    active = -1;
    render();
  }

  function pick(i: number) {
    const m = options[i];
    if (!m) return;
    input.value = m.fullAddress;
    close();
    h.onPick(m);
  }

  function move(delta: number) {
    if (!options.length) return;
    active = (active + delta + options.length) % options.length;
    render();
    document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' });
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < AUTOCOMPLETE.minChars) {
      close();
      return;
    }
    timer = setTimeout(async () => {
      controller?.abort();
      const mine = new AbortController();
      controller = mine;
      try {
        const found = await h.fetchSuggestions(q, mine.signal);
        if (controller !== mine) return;
        options = found;
        active = -1;
        render();
      } catch (e) {
        if (!isAbortError(e) && controller === mine) {
          options = [];
          render(); // suggestions are a nicety; a failed lookup just shows none
        }
      }
    }, AUTOCOMPLETE.debounceMs);
  });

  input.addEventListener('keydown', (ev) => {
    switch (ev.key) {
      case 'ArrowDown':
        ev.preventDefault();
        move(1);
        break;
      case 'ArrowUp':
        ev.preventDefault();
        move(-1);
        break;
      case 'Escape':
        if (options.length) {
          ev.preventDefault();
          close();
        }
        break;
      case 'Enter':
        if (active >= 0) {
          ev.preventDefault();
          pick(active);
        }
        break;
    }
  });

  input.addEventListener('blur', () => close());

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const text = input.value.trim();
    const exact = options.findIndex((m) => m.fullAddress.toLowerCase() === text.toLowerCase());
    if (exact >= 0) {
      pick(exact);
      return;
    }
    close();
    h.onSubmitText(text);
  });

  return {
    setValue(text) {
      input.value = text;
    },
    close,
  };
}
