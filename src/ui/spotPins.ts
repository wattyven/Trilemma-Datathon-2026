// The two pins marking the sunniest and shadiest spots: buttons in a layer over the 3D view or the
// map. Each is a dot exactly on its spot, a short stem and a small label. The views say where a
// cell appears on screen; this labels the pins and places them.

export type SpotKind = 'sunniest' | 'shadiest';

export interface PinSpec {
  kind: SpotKind;
  cell: number;
  /** Visible label, and the rest of the button's name for screen readers. */
  text: string;
  more: string;
}

type Projector = (cell: number) => { x: number; y: number } | null;

const EDGE = 4; // px kept clear of the view's edges by the label
const FLASH_MS = 1600;

interface Pin {
  el: HTMLButtonElement;
  label: HTMLElement;
  text: HTMLElement;
  more: HTMLElement;
  dot: HTMLElement;
}

export class SpotPins {
  private pins = new Map<SpotKind, Pin>();
  private specs: PinSpec[] = [];
  private flashTimers = new Map<SpotKind, ReturnType<typeof setTimeout>>();

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
      const label = Object.assign(document.createElement('span'), { className: 'spot-label' });
      const text = document.createElement('span');
      const more = Object.assign(document.createElement('span'), { className: 'visually-hidden' });
      label.append(text, more);
      const stem = Object.assign(document.createElement('span'), { className: 'spot-stem' });
      const dot = Object.assign(document.createElement('span'), { className: 'spot-dot' });
      dot.dataset.kind = kind;
      for (const x of [stem, dot]) x.setAttribute('aria-hidden', 'true');
      el.append(label, stem, dot);
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
      this.pins.set(kind, { el, label, text, more, dot });
    }
  }

  /** Which pins to show, and their labels. Placing them is up to `place()`. */
  set(specs: PinSpec[]) {
    this.specs = specs;
    for (const [kind, p] of this.pins) {
      const spec = specs.find((s) => s.kind === kind);
      if (!spec) p.el.hidden = true;
      else {
        p.text.textContent = spec.text;
        p.more.textContent = spec.more;
      }
    }
  }

  clear() {
    this.set([]);
  }

  /** Pulse a pin's dot so it's easy to find (from the summary's "north-east" and the like). */
  highlight(kind: SpotKind) {
    const p = this.pins.get(kind);
    if (!p) return;
    p.el.classList.remove('flash');
    void p.el.offsetWidth; // restart the animation
    p.el.classList.add('flash');
    clearTimeout(this.flashTimers.get(kind));
    this.flashTimers.set(kind, setTimeout(() => p.el.classList.remove('flash'), FLASH_MS));
  }

  /**
   * Put each pin's dot on its spot, with the label above (or below, when there's no room above or
   * the labels would overlap); hide pins whose spot is off screen.
   */
  place(project: Projector) {
    const w = this.layer.clientWidth;
    const placed: { left: number; top: number; right: number; bottom: number }[] = [];
    for (const [kind, p] of this.pins) {
      const spec = this.specs.find((s) => s.kind === kind);
      const at = spec ? project(spec.cell) : null;
      p.el.hidden = !at;
      if (!at) continue;
      p.el.dataset.below = 'false';
      const bw = p.el.offsetWidth, bh = p.el.offsetHeight, dot = p.dot.offsetHeight, lh = p.label.offsetHeight, lw = p.label.offsetWidth;
      const left = at.x - bw / 2;
      // Keep the label inside the view by sliding it sideways; the dot stays on the spot.
      const labelLeft = at.x - lw / 2;
      const shift = labelLeft < EDGE ? EDGE - labelLeft : labelLeft + lw > w - EDGE ? w - EDGE - (labelLeft + lw) : 0;
      p.label.style.setProperty('--label-shift', `${Math.round(shift)}px`);
      const above = { top: at.y - bh + dot / 2, labelTop: at.y - bh + dot / 2 };
      const overlaps = (t: number) => placed.some((r) => labelLeft + shift < r.right && labelLeft + shift + lw > r.left && t < r.bottom && t + lh > r.top);
      const below = above.labelTop < EDGE || overlaps(above.labelTop);
      p.el.dataset.below = String(below);
      const top = below ? at.y - dot / 2 : above.top;
      const labelTop = below ? at.y - dot / 2 + (bh - lh) : above.labelTop;
      p.el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
      placed.push({ left: labelLeft + shift, top: labelTop, right: labelLeft + shift + lw, bottom: labelTop + lh });
    }
  }
}
