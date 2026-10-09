// The two pins marking the sunniest and shadiest spots: buttons in a layer over the 3D view or the
// map. The views say where a cell appears on screen; this labels the pins and places them.

export type SpotKind = 'sunniest' | 'shadiest';

export interface PinSpec {
  kind: SpotKind;
  cell: number;
  /** Visible label, and the rest of the button's name for screen readers. */
  text: string;
  more: string;
}

type Projector = (cell: number) => { x: number; y: number } | null;

const GAP = 10; // px between a pill and its spot (the tail fills it)
const EDGE = 4; // px kept clear of the view's edges

export class SpotPins {
  private buttons = new Map<SpotKind, { el: HTMLButtonElement; text: HTMLElement; more: HTMLElement }>();
  private specs: PinSpec[] = [];

  /**
   * @param onPick a pin was clicked
   * @param wheelTarget where a scroll-wheel turn over a pin goes (the 3D canvas zooms with it)
   */
  constructor(private layer: HTMLElement, onPick: (cell: number) => void, wheelTarget: () => HTMLElement | null) {
    for (const kind of ['sunniest', 'shadiest'] as const) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'spot-pin';
      el.dataset.kind = kind;
      el.hidden = true;
      const dot = Object.assign(document.createElement('span'), { className: 'spot-dot' });
      dot.setAttribute('aria-hidden', 'true');
      const text = document.createElement('span');
      const more = Object.assign(document.createElement('span'), { className: 'visually-hidden' });
      el.append(dot, text, more);
      el.addEventListener('click', () => {
        const spec = this.specs.find((s) => s.kind === kind);
        if (spec) onPick(spec.cell);
      });
      el.addEventListener(
        'wheel',
        (e) => {
          const target = wheelTarget();
          if (!target) return;
          e.preventDefault();
          target.dispatchEvent(new WheelEvent('wheel', e));
        },
        { passive: false },
      );
      layer.append(el);
      this.buttons.set(kind, { el, text, more });
    }
  }

  /** Which pins to show, and their labels. Placing them is up to `place()`. */
  set(specs: PinSpec[]) {
    this.specs = specs;
    for (const [kind, b] of this.buttons) {
      const spec = specs.find((s) => s.kind === kind);
      if (!spec) b.el.hidden = true;
      else {
        b.text.textContent = spec.text;
        b.more.textContent = spec.more;
      }
    }
  }

  clear() {
    this.set([]);
  }

  /** Put each pin above its spot (or below, if there's no room or the pins would overlap); hide pins whose spot is off screen. */
  place(project: Projector) {
    const w = this.layer.clientWidth, h = this.layer.clientHeight;
    const placed: { left: number; top: number; right: number; bottom: number }[] = [];
    for (const [kind, b] of this.buttons) {
      const spec = this.specs.find((s) => s.kind === kind);
      const at = spec ? project(spec.cell) : null;
      b.el.hidden = !at;
      if (!at) continue;
      const bw = b.el.offsetWidth, bh = b.el.offsetHeight;
      const left = Math.min(Math.max(EDGE, at.x - bw / 2), Math.max(EDGE, w - bw - EDGE));
      let top = at.y - bh - GAP;
      const overlaps = (t: number) => placed.some((r) => left < r.right && left + bw > r.left && t < r.bottom && t + bh > r.top);
      const below = top < EDGE || overlaps(top);
      if (below) top = Math.min(at.y + GAP, h - bh - EDGE);
      b.el.dataset.below = String(below);
      b.el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
      b.el.style.setProperty('--tail-x', `${Math.round(Math.min(Math.max(at.x - left, 10), bw - 10))}px`);
      placed.push({ left, top, right: left + bw, bottom: top + bh });
    }
  }
}
