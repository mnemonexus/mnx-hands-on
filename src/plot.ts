/**
 * A shared SVG plot for engines that draw a curve: axes on a linear or log scale, any number of curves that redraw as
 * their function changes, and markers that can be dragged with the pointer or moved with the keyboard.
 *
 * The plot measures its container and draws in real pixels, so text stays the same size at any width. Everything is
 * styled by classes (see style.css) that read only the host's --mnx-* tokens. No subject lives here.
 */
import { clamp, fmt, fromUnit, tickLabel, ticks, toUnit, type Scale } from './scale';

const NS = 'http://www.w3.org/2000/svg';

type Attrs = Record<string, string | number | undefined>;
export function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Attrs = {}, parent?: Element): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) node.setAttribute(k, String(v));
  parent?.append(node);
  return node;
}

export interface PlotAxis extends Scale { title: string }

let counter = 0;

export class Plot {
  readonly root: HTMLDivElement;
  readonly svg: SVGSVGElement;
  readonly layers: Record<'back' | 'curves' | 'guides' | 'marks', SVGGElement>;
  w = 0;
  h = 0;
  /** Space left around the drawing area for tick labels and titles. */
  readonly margin = { l: 58, r: 18, t: 14, b: 46 };
  private readonly watchers: Array<() => void> = [];
  private readonly curves: Curve[] = [];
  private readonly markers: Marker[] = [];
  private readonly observer: ResizeObserver;
  private readonly clipId = `ho-clip-${++counter}`;
  private clipRect!: SVGRectElement;

  constructor(parent: HTMLElement, readonly xa: PlotAxis, readonly ya: PlotAxis, label: string) {
    this.root = document.createElement('div');
    this.root.className = 'ho-plot';
    this.svg = svgEl('svg', { role: 'img', 'aria-label': label, class: 'ho-svg' });
    const defs = svgEl('defs', {}, this.svg);
    const clip = svgEl('clipPath', { id: this.clipId }, defs);
    this.clipRect = svgEl('rect', {}, clip);
    this.layers = {
      back: svgEl('g', { class: 'ho-back' }, this.svg),
      curves: svgEl('g', { class: 'ho-curves', 'clip-path': `url(#${this.clipId})` }, this.svg),
      guides: svgEl('g', { class: 'ho-guides' }, this.svg),
      marks: svgEl('g', { class: 'ho-marks' }, this.svg),
    };
    this.root.append(this.svg);
    parent.append(this.root);
    this.observer = new ResizeObserver(() => { if (this.root.clientWidth !== this.w) this.relayout(); });
    this.observer.observe(this.root);
    this.relayout();
  }

  // Drawing area, in pixels.
  get left() { return this.margin.l; }
  get right() { return this.w - this.margin.r; }
  get top() { return this.margin.t; }
  get bottom() { return this.h - this.margin.b; }

  px(value: number) { return this.left + toUnit(this.xa, value) * (this.right - this.left); }
  py(value: number) { return this.bottom - toUnit(this.ya, value) * (this.bottom - this.top); }
  /** Pixels back to data, clamped to the axes. */
  dataX(pixel: number) { return fromUnit(this.xa, clamp((pixel - this.left) / (this.right - this.left), 0, 1)); }
  dataY(pixel: number) { return fromUnit(this.ya, clamp((this.bottom - pixel) / (this.bottom - this.top), 0, 1)); }

  /** Called after every layout, so whatever positions itself from data can follow a resize. */
  onLayout(fn: () => void) { this.watchers.push(fn); }

  add(item: Curve | Marker) { if (item instanceof Curve) this.curves.push(item); else this.markers.push(item); }

  /** The pointer's place inside the svg, in pixels. */
  pointer(ev: PointerEvent | MouseEvent) {
    const r = this.svg.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }

  relayout() {
    const width = Math.round(this.root.clientWidth);
    if (width < 40) return;
    this.w = width;
    this.h = Math.round(clamp(width * 0.56, 250, 400));
    this.margin.l = width < 460 ? 50 : 58;
    this.svg.setAttribute('viewBox', `0 0 ${this.w} ${this.h}`);
    this.svg.setAttribute('width', String(this.w));
    this.svg.setAttribute('height', String(this.h));
    this.clipRect.setAttribute('x', String(this.left));
    this.clipRect.setAttribute('y', String(this.top - 2));
    this.clipRect.setAttribute('width', String(this.right - this.left));
    this.clipRect.setAttribute('height', String(this.bottom - this.top + 4));
    this.drawAxes();
    for (const c of this.curves) c.draw();
    for (const m of this.markers) m.place();
    for (const fn of this.watchers) fn();
  }

  private drawAxes() {
    const g = this.layers.back;
    g.replaceChildren();
    const { left, right, top, bottom } = this;
    svgEl('rect', { class: 'ho-area', x: left, y: top, width: right - left, height: bottom - top }, g);

    const xt = ticks(this.xa, Math.max(3, Math.round((right - left) / 90)));
    const yt = ticks(this.ya, Math.max(3, Math.round((bottom - top) / 50)));
    // A long log axis is thinned so its labels never touch.
    const decades = this.xa.scale === 'log' ? xt.filter((t) => t.major).length : 0;
    const every = decades > 0 ? Math.max(1, Math.ceil(decades / Math.max(2, Math.floor((right - left) / 56)))) : 1;
    let major = -1;
    for (const t of xt) {
      const x = this.px(t.value);
      if (t.major) major++;
      svgEl('line', { class: t.major ? 'ho-grid' : 'ho-grid ho-grid--minor', x1: x, x2: x, y1: top, y2: bottom }, g);
      if (!t.major) continue;
      svgEl('line', { class: 'ho-tickmark', x1: x, x2: x, y1: bottom, y2: bottom + 4 }, g);
      if (major % every === 0) svgEl('text', { class: 'ho-ticklabel', x, y: bottom + 18, 'text-anchor': 'middle' }, g).textContent = tickLabel(t.value);
    }
    for (const t of yt) {
      const y = this.py(t.value);
      if (!t.major) continue;
      svgEl('line', { class: 'ho-grid', x1: left, x2: right, y1: y, y2: y }, g);
      svgEl('line', { class: 'ho-tickmark', x1: left - 4, x2: left, y1: y, y2: y }, g);
      svgEl('text', { class: 'ho-ticklabel', x: left - 8, y: y + 4, 'text-anchor': 'end' }, g).textContent = tickLabel(t.value);
    }
    svgEl('line', { class: 'ho-axis', x1: left, x2: right, y1: bottom, y2: bottom }, g);
    svgEl('line', { class: 'ho-axis', x1: left, x2: left, y1: top, y2: bottom }, g);
    svgEl('text', { class: 'ho-axistitle', x: (left + right) / 2, y: this.h - 6, 'text-anchor': 'middle' }, g).textContent = this.xa.title;
    const yTitle = svgEl('text', { class: 'ho-axistitle', x: 12, y: (top + bottom) / 2, 'text-anchor': 'middle', transform: `rotate(-90 12 ${(top + bottom) / 2})` }, g);
    yTitle.textContent = this.ya.title;
  }

  destroy() {
    this.observer.disconnect();
    this.root.remove();
  }
}

// ── Curves ───────────────────────────────────────────────────────────────────

/** A line drawn from a function of x. Give it a new function and it redraws; a resize redraws it too. */
export class Curve {
  readonly path: SVGPathElement;
  private fn: ((x: number) => number) | null = null;

  constructor(private readonly plot: Plot, className: string) {
    this.path = svgEl('path', { class: `ho-curve ${className}`, fill: 'none' }, plot.layers.curves);
    plot.add(this);
  }

  set(fn: ((x: number) => number) | null) { this.fn = fn; this.draw(); }
  show(visible: boolean) { this.path.style.display = visible ? '' : 'none'; }

  draw() {
    const { plot, fn } = this;
    if (!fn || plot.w === 0) { this.path.setAttribute('d', ''); return; }
    const steps = Math.round(clamp((plot.right - plot.left) / 2.5, 60, 320));
    let d = '';
    let pen = false;
    const low = plot.top - 40;
    const high = plot.bottom + 40;
    for (let i = 0; i <= steps; i++) {
      const x = fromUnit(plot.xa, i / steps);
      const v = fn(x);
      if (!Number.isFinite(v)) { pen = false; continue; }
      const py = clamp(plot.py(v), low, high);
      d += `${pen ? 'L' : 'M'}${(plot.left + (i / steps) * (plot.right - plot.left)).toFixed(1)} ${py.toFixed(1)}`;
      pen = true;
    }
    this.path.setAttribute('d', d);
  }
}

// ── Markers ──────────────────────────────────────────────────────────────────

export interface MarkerOptions {
  /** disc: a filled point. ring: a hollow one, for a guess. now: a small quiet point for where things started. */
  kind: 'disc' | 'ring' | 'now';
  tag?: string;
  /** For screen readers. */
  label?: string;
}

export interface DragOptions {
  /** Which way it may move: along x, along y, or both. */
  axis: 'x' | 'y' | 'xy';
  /** Called as it moves, with data coordinates. The marker has already moved. */
  onMove: (x: number, y: number) => void;
  /** Called when the pointer is let go. */
  onEnd?: () => void;
  /** Called when Enter is pressed on the marker. */
  onCommit?: () => void;
  /** Words for a screen reader, and for the tag while dragging. */
  valueText: (x: number, y: number) => string;
  /** Show lines to the axes with the value on each, while it is held. */
  guides?: boolean;
}

export class Marker {
  readonly g: SVGGElement;
  x = 0;
  y = 0;
  dragging = false;
  /** Which side the tag is on. Engines that show several markers together use this to keep their tags apart. */
  tagSide: 'auto' | 'above' | 'below' | 'left' | 'right' = 'auto';
  private readonly dot: SVGCircleElement;
  private readonly tag: SVGTextElement;
  private shown = true;
  private opts?: DragOptions;
  private grabber?: (ev: PointerEvent) => void;
  private guide?: { h: SVGLineElement; v: SVGLineElement; xt: SVGGElement; yt: SVGGElement };

  constructor(private readonly plot: Plot, o: MarkerOptions) {
    const r = o.kind === 'now' ? 5 : 9;
    this.g = svgEl('g', { class: `ho-m ho-m--${o.kind}` }, plot.layers.marks);
    svgEl('circle', { class: 'ho-m__focus', r: r + 9 }, this.g);
    svgEl('circle', { class: 'ho-m__hit', r: Math.max(r + 10, 20) }, this.g);
    this.dot = svgEl('circle', { class: 'ho-m__dot', r }, this.g);
    this.tag = svgEl('text', { class: 'ho-m__tag' }, this.g);
    if (o.tag) this.tag.textContent = o.tag;
    if (o.label) this.g.setAttribute('aria-label', o.label);
    plot.add(this);
  }

  /** Put it at a place in data coordinates. A place off the axes is held at the nearest edge. */
  set(x: number, y: number) {
    this.x = x; this.y = y;
    this.place();
  }

  setTag(text: string) { this.tag.textContent = text; this.place(); }
  show(visible: boolean) { this.shown = visible; this.g.style.display = visible ? '' : 'none'; }
  get visible() { return this.shown; }

  /** Where it is on the plot now, in pixels. */
  pixel() {
    const { plot } = this;
    return {
      x: clamp(plot.px(this.x), plot.left, plot.right),
      y: clamp(plot.py(this.y), plot.top, plot.bottom),
    };
  }

  place() {
    const { plot } = this;
    if (plot.w === 0 || !Number.isFinite(this.x) || !Number.isFinite(this.y)) return;
    const p = this.pixel();
    this.g.setAttribute('transform', `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`);
    this.g.dataset.clamped = plot.px(this.x) !== p.x || plot.py(this.y) !== p.y ? 'true' : 'false';
    // The tag goes where it was told to, or to whichever side has room.
    const nearRight = p.x > plot.right - 90;
    const nearTop = p.y < plot.top + 28;
    const side = this.tagSide === 'auto' ? (nearTop ? 'below' : 'above') : this.tagSide;
    const sideways = side === 'left' || side === 'right';
    const toLeft = side === 'left' || (!sideways && nearRight);
    this.tag.setAttribute('x', String(toLeft ? -14 : 14));
    this.tag.setAttribute('y', String(sideways ? 4 : side === 'below' ? 22 : -12));
    this.tag.setAttribute('text-anchor', toLeft ? 'end' : 'start');
    if (this.guide) this.drawGuides(p);
  }

  private drawGuides(p: { x: number; y: number }) {
    const gd = this.guide;
    if (!gd) return;
    const { plot } = this;
    const on = this.dragging || this.g === document.activeElement || this.g.contains(document.activeElement);
    for (const el of [gd.h, gd.v, gd.xt, gd.yt]) (el as SVGElement).style.display = on ? '' : 'none';
    if (!on) return;
    gd.h.setAttribute('x1', String(plot.left)); gd.h.setAttribute('x2', String(p.x)); gd.h.setAttribute('y1', String(p.y)); gd.h.setAttribute('y2', String(p.y));
    gd.v.setAttribute('x1', String(p.x)); gd.v.setAttribute('x2', String(p.x)); gd.v.setAttribute('y1', String(p.y)); gd.v.setAttribute('y2', String(plot.bottom));
    const put = (box: SVGGElement, text: string, cx: number | ((width: number) => number), cy: number) => {
      const t = box.querySelector('text') as SVGTextElement;
      const r = box.querySelector('rect') as SVGRectElement;
      t.textContent = text;
      const width = text.length * 6.6 + 12;
      r.setAttribute('x', String(-width / 2)); r.setAttribute('width', String(width));
      box.setAttribute('transform', `translate(${(typeof cx === 'function' ? cx(width) : cx).toFixed(1)} ${cy.toFixed(1)})`);
    };
    put(gd.xt, fmt(this.x), p.x, plot.bottom + 4 + 9);
    // The y tag sits just inside the plot, so it never lands on the axis title.
    put(gd.yt, fmt(this.y), (width) => plot.left + 6 + width / 2, p.y);
  }

  private ensureGuides() {
    if (this.guide) return;
    const layer = this.plot.layers.guides;
    const tagBox = () => {
      const box = svgEl('g', { class: 'ho-axistag' }, layer);
      svgEl('rect', { y: -9, height: 18, rx: 4 }, box);
      svgEl('text', { y: 4, 'text-anchor': 'middle' }, box);
      return box;
    };
    this.guide = {
      h: svgEl('line', { class: 'ho-guideline' }, layer),
      v: svgEl('line', { class: 'ho-guideline' }, layer),
      xt: tagBox(),
      yt: tagBox(),
    };
    for (const el of [this.guide.h, this.guide.v, this.guide.xt, this.guide.yt]) (el as SVGElement).style.display = 'none';
  }

  /** Let the marker be picked up. Returns a function that undoes it. */
  drag(o: DragOptions): () => void {
    this.opts = o;
    const { plot, g } = this;
    if (o.guides) this.ensureGuides();
    g.setAttribute('tabindex', '0');
    g.setAttribute('role', 'slider');
    g.setAttribute('aria-orientation', o.axis === 'y' ? 'vertical' : 'horizontal');
    g.setAttribute('aria-valuemin', '0');
    g.setAttribute('aria-valuemax', '1');
    g.dataset.draggable = 'true';
    const axisOf = () => (o.axis === 'x' ? plot.xa : plot.ya);
    const announce = () => {
      const along = toUnit(axisOf(), o.axis === 'x' ? this.x : this.y);
      g.setAttribute('aria-valuenow', along.toFixed(3));
      g.setAttribute('aria-valuetext', o.valueText(this.x, this.y));
      this.setTag(o.valueText(this.x, this.y));
    };
    announce();

    let grabX = 0; let grabY = 0;
    const begin = (ev: PointerEvent, offset: boolean) => {
      ev.preventDefault();
      g.setPointerCapture(ev.pointerId);
      const here = this.pixel();
      const at = plot.pointer(ev);
      grabX = offset ? at.x - here.x : 0; grabY = offset ? at.y - here.y : 0;
      this.dragging = true;
      g.dataset.dragging = 'true';
      g.focus({ preventScroll: true });
      this.place();
      if (!offset) move(ev);
    };
    const down = (ev: PointerEvent) => { if (ev.button === 0) begin(ev, true); };
    this.grabber = (ev) => begin(ev, false);
    const move = (ev: PointerEvent) => {
      if (!this.dragging) return;
      const at = plot.pointer(ev);
      const nx = o.axis === 'y' ? this.x : plot.dataX(at.x - grabX);
      const ny = o.axis === 'x' ? this.y : plot.dataY(at.y - grabY);
      this.x = nx; this.y = ny;
      this.place();
      announce();
      o.onMove(nx, ny);
    };
    const up = (ev: PointerEvent) => {
      if (!this.dragging) return;
      this.dragging = false;
      delete g.dataset.dragging;
      if (g.hasPointerCapture(ev.pointerId)) g.releasePointerCapture(ev.pointerId);
      this.place();
      o.onEnd?.();
    };
    const key = (ev: KeyboardEvent) => {
      if (ev.key === 'Enter') { ev.preventDefault(); o.onCommit?.(); return; }
      const axis = axisOf();
      const fine = ev.shiftKey ? 0.05 : ev.altKey ? 0.002 : 0.01;
      let delta = 0; let jump: number | null = null;
      if (ev.key === 'ArrowUp' || ev.key === 'ArrowRight') delta = fine;
      else if (ev.key === 'ArrowDown' || ev.key === 'ArrowLeft') delta = -fine;
      else if (ev.key === 'PageUp') delta = 0.1;
      else if (ev.key === 'PageDown') delta = -0.1;
      else if (ev.key === 'Home') jump = 0;
      else if (ev.key === 'End') jump = 1;
      else return;
      ev.preventDefault();
      const current = toUnit(axis, o.axis === 'x' ? this.x : this.y);
      const next = fromUnit(axis, clamp(jump ?? current + delta, 0, 1));
      if (o.axis === 'x') this.x = next; else this.y = next;
      this.place();
      announce();
      o.onMove(this.x, this.y);
    };
    const refocus = () => this.place();
    g.addEventListener('pointerdown', down);
    g.addEventListener('pointermove', move);
    g.addEventListener('pointerup', up);
    g.addEventListener('pointercancel', up);
    g.addEventListener('keydown', key);
    g.addEventListener('focus', refocus);
    g.addEventListener('blur', refocus);
    return () => {
      g.removeEventListener('pointerdown', down);
      g.removeEventListener('pointermove', move);
      g.removeEventListener('pointerup', up);
      g.removeEventListener('pointercancel', up);
      g.removeEventListener('keydown', key);
      g.removeEventListener('focus', refocus);
      g.removeEventListener('blur', refocus);
      for (const a of ['tabindex', 'role', 'aria-orientation', 'aria-valuemin', 'aria-valuemax', 'aria-valuenow', 'aria-valuetext']) g.removeAttribute(a);
      delete g.dataset.draggable;
      delete g.dataset.dragging;
      this.dragging = false;
      this.opts = undefined;
      this.grabber = undefined;
      if (this.guide) for (const el of [this.guide.h, this.guide.v, this.guide.xt, this.guide.yt]) (el as SVGElement).style.display = 'none';
    };
  }

  /** Pick the marker up from somewhere else on the plot: it jumps under the pointer and follows it. */
  grab(ev: PointerEvent) { this.grabber?.(ev); }

  /** The words for the current place, as the drag options give them. */
  valueText() { return this.opts?.valueText(this.x, this.y) ?? ''; }

  destroy() { this.g.remove(); this.guide?.h.remove(); this.guide?.v.remove(); this.guide?.xt.remove(); this.guide?.yt.remove(); }
}

/** A straight line between two places in data coordinates, redrawn on resize. */
export class Segment {
  readonly line: SVGLineElement;
  private a = { x: 0, y: 0 };
  private b = { x: 0, y: 0 };

  constructor(private readonly plot: Plot, className: string, layer: 'guides' | 'curves' = 'guides') {
    this.line = svgEl('line', { class: className }, plot.layers[layer]);
    plot.onLayout(() => this.draw());
  }

  set(ax: number, ay: number, bx: number, by: number) { this.a = { x: ax, y: ay }; this.b = { x: bx, y: by }; this.draw(); }
  show(visible: boolean) { this.line.style.display = visible ? '' : 'none'; }

  draw() {
    const { plot } = this;
    if (plot.w === 0) return;
    const f = (p: { x: number; y: number }) => ({ x: clamp(plot.px(p.x), plot.left, plot.right), y: clamp(plot.py(p.y), plot.top, plot.bottom) });
    const a = f(this.a); const b = f(this.b);
    this.line.setAttribute('x1', a.x.toFixed(1)); this.line.setAttribute('y1', a.y.toFixed(1));
    this.line.setAttribute('x2', b.x.toFixed(1)); this.line.setAttribute('y2', b.y.toFixed(1));
  }
}
