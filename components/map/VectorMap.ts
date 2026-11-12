// The canvas map: every film as a dot sized by popularity and coloured by kind, kind and
// sub-cluster labels by zoom, faint cross-kind threads, the selected film's lines to its nearest
// films, and the recommend view. Zoom with the wheel or a pinch about the pointer, pan by dragging.
// Draws only when something changed (or while the selection halo pulses).
import type { MapData } from './data';
import type { Rec } from './recommend';

export interface MapHooks {
  /** A film under the pointer (or null), with the pointer's screen position. */
  hover(film: number | null, x: number, y: number): void;
  /** A click on a film, or on empty space (null). */
  select(film: number | null): void;
}

interface View { s: number; tx: number; ty: number }
type Box = [number, number, number, number];

const BG = '#0a0b0f';
const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif';
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

const hexRgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(',');

export class VectorMap {
  // state the page sets
  selected: number | null = null;
  neighbours: [number, number][] = []; // [film, match]
  hoverNb: number | null = null; // a neighbour hovered in the list
  highlighted: Uint8Array | null = null;
  visible: Uint8Array;
  rec: { like: number[]; dislike: number[]; results: Rec[] } | null = null;
  /** Films named by the chat's latest answer, in order (badge n = position + 1). */
  chat: { films: number[]; hover: number | null } | null = null;
  showLabels = true;
  insets = { left: 0, right: 0, top: 0, bottom: 0 };

  private ctx: CanvasRenderingContext2D;
  private W = 0;
  private H = 0;
  private dpr = 1;
  private view: View = { s: 1, tx: 0, ty: 0 };
  private fitScale = 1;
  private anim: { from: View; to: View; t0: number; ms: number } | null = null;
  private hovered: number | null = null;
  private frame = 0;
  private order: number[]; // films sorted by colour, for fewer fillStyle changes
  private sizeMul: Float32Array;
  private kindRgb: string[];
  private pointers = new Map<number, { x: number; y: number }>();
  private drag: { x: number; y: number; moved: boolean; pinch: number } | null = null;

  constructor(private cv: HTMLCanvasElement, private data: MapData, private hooks: MapHooks) {
    this.ctx = cv.getContext('2d')!;
    this.visible = new Uint8Array(data.films.length).fill(1);
    this.sizeMul = Float32Array.from(data.films, f => 0.7 + f.pop * 1.7);
    this.order = data.films.map(f => f.i).sort((a, b) => (data.films[a].color < data.films[b].color ? -1 : 1));
    this.kindRgb = data.kinds.map(k => hexRgb(k.color));
    this.resize();
    this.fit(false);
    addEventListener('resize', () => {
      this.resize();
      this.invalidate();
    });
    cv.addEventListener('wheel', this.onWheel, { passive: false });
    cv.addEventListener('pointerdown', this.onDown);
    addEventListener('pointermove', this.onMove);
    addEventListener('pointerup', this.onUp);
    addEventListener('pointercancel', this.onUp);
    cv.addEventListener('pointerleave', () => this.setHover(null, 0, 0));
    cv.addEventListener('dblclick', e => {
      if (this.pick(e.clientX, e.clientY) === null) this.fit(true);
    });
  }

  // ---------- view ----------

  private resize() {
    this.dpr = devicePixelRatio || 1;
    this.W = innerWidth;
    this.H = innerHeight;
    this.cv.width = this.W * this.dpr;
    this.cv.height = this.H * this.dpr;
    this.cv.style.width = `${this.W}px`;
    this.cv.style.height = `${this.H}px`;
    this.fitScale = this.fitFor().s;
  }

  /** The visible area between the open panels. */
  private area() {
    const { left, right, top, bottom } = this.insets;
    return { x: left, y: top, w: this.W - left - right, h: this.H - top - bottom };
  }

  private fitFor(): View {
    const a = this.area(), pad = Math.min(90, a.w * 0.08);
    const s = Math.max(10, Math.min((a.w - pad * 2) / 2.2, (a.h - pad * 2) / 2.2));
    return { s, tx: a.x + a.w / 2, ty: a.y + a.h / 2 };
  }

  get zoom() {
    return this.view.s / this.fitScale;
  }

  private animateTo(to: View, animate: boolean) {
    if (!animate || reducedMotion()) {
      this.view = to;
      this.anim = null;
    } else this.anim = { from: { ...this.view }, to, t0: performance.now(), ms: 420 };
    this.invalidate();
  }

  fit(animate = true) {
    this.animateTo(this.fitFor(), animate);
  }

  /** Centre a film in the visible area, zooming in if the map is zoomed out. */
  centerOn(i: number, animate = true) {
    const f = this.data.films[i], a = this.area();
    const s = Math.max(this.view.s, this.fitScale * 1.8);
    this.animateTo({ s, tx: a.x + a.w / 2 - f.x * s, ty: a.y + a.h / 2 - f.y * s }, animate);
  }

  /** Zoom to fit a set of films in the visible area (one film: centre on it). */
  fitFilms(ids: number[], animate = true) {
    if (!ids.length) return;
    if (ids.length === 1) return this.centerOn(ids[0], animate);
    const fs = ids.map(i => this.data.films[i]);
    const x0 = Math.min(...fs.map(f => f.x)), x1 = Math.max(...fs.map(f => f.x));
    const y0 = Math.min(...fs.map(f => f.y)), y1 = Math.max(...fs.map(f => f.y));
    const a = this.area(), pad = 90;
    const s = Math.min(this.fitScale * 6, Math.max(this.fitScale * 0.8, Math.min((a.w - pad * 2) / Math.max(x1 - x0, 0.05), (a.h - pad * 2) / Math.max(y1 - y0, 0.05))));
    this.animateTo({ s, tx: a.x + a.w / 2 - ((x0 + x1) / 2) * s, ty: a.y + a.h / 2 - ((y0 + y1) / 2) * s }, animate);
  }

  zoomBy(k: number, cx = this.W / 2, cy = this.H / 2) {
    const v = this.anim?.to ?? this.view;
    const s = Math.min(this.fitScale * 40, Math.max(this.fitScale * 0.5, v.s * k));
    const r = s / v.s;
    this.animateTo({ s, tx: cx - (cx - v.tx) * r, ty: cy - (cy - v.ty) * r }, true);
  }

  screenOf(i: number) {
    const f = this.data.films[i];
    return { x: f.x * this.view.s + this.view.tx, y: f.y * this.view.s + this.view.ty };
  }

  // ---------- input ----------

  private dotRadius(i: number) {
    return this.base() * this.sizeMul[i];
  }

  private base() {
    return 1.6 * Math.min(4, Math.max(1, Math.sqrt(this.zoom)));
  }

  private pickable(i: number) {
    if (!this.visible[i]) return false;
    if (this.highlighted && !this.highlighted[i]) return false;
    return true;
  }

  /** The film under a screen point, preferring bigger dots, within an 8 px tolerance. */
  pick(px: number, py: number): number | null {
    const { s, tx, ty } = this.view;
    let best: number | null = null, bestD = Infinity;
    for (const f of this.data.films) {
      if (!this.pickable(f.i)) continue;
      const dx = f.x * s + tx - px, dy = f.y * s + ty - py, dd = dx * dx + dy * dy;
      const tol = Math.max(8, this.dotRadius(f.i) + 3);
      if (dd > tol * tol) continue;
      const eff = dd / (this.sizeMul[f.i] * this.sizeMul[f.i]);
      if (eff < bestD) (bestD = eff), (best = f.i);
    }
    return best;
  }

  /** A point on screen with no film near it (for checks). */
  emptyPoint() {
    const a = this.area();
    for (let y = a.y + 40; y < a.y + a.h - 40; y += 23)
      for (let x = a.x + 40; x < a.x + a.w - 40; x += 23) if (this.pick(x, y) === null) return { x, y };
    return { x: a.x + 5, y: a.y + 5 };
  }

  private setHover(i: number | null, x: number, y: number) {
    if (i !== this.hovered) {
      this.hovered = i;
      this.cv.classList.toggle('pointing', i !== null);
      this.invalidate();
    }
    this.hooks.hover(i, x, y);
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    const k = Math.exp(-dy * 0.0016);
    // Wheel zoom is immediate, so it tracks the wheel without lag.
    const v = this.view;
    const s = Math.min(this.fitScale * 40, Math.max(this.fitScale * 0.5, v.s * k));
    const r = s / v.s;
    this.anim = null;
    this.view = { s, tx: e.clientX - (e.clientX - v.tx) * r, ty: e.clientY - (e.clientY - v.ty) * r };
    this.invalidate();
  };

  private onDown = (e: PointerEvent) => {
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.anim = null;
    if (this.pointers.size === 1) this.drag = { x: e.clientX, y: e.clientY, moved: false, pinch: 0 };
    else if (this.pointers.size === 2 && this.drag) {
      const [a, b] = [...this.pointers.values()];
      this.drag.pinch = Math.hypot(a.x - b.x, a.y - b.y);
      this.drag.moved = true;
    }
    this.cv.setPointerCapture?.(e.pointerId);
  };

  private onMove = (e: PointerEvent) => {
    const prev = this.pointers.get(e.pointerId);
    if (!prev || !this.drag) {
      if (e.target === this.cv && e.pointerType === 'mouse') this.setHover(this.pick(e.clientX, e.clientY), e.clientX, e.clientY);
      return;
    }
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      if (this.drag.pinch) {
        const v = this.view, s = Math.min(this.fitScale * 40, Math.max(this.fitScale * 0.5, (v.s * d) / this.drag.pinch)), r = s / v.s;
        this.view = { s, tx: mx - (mx - v.tx) * r + (e.clientX - prev.x) / 2, ty: my - (my - v.ty) * r + (e.clientY - prev.y) / 2 };
      }
      this.drag.pinch = d;
      this.invalidate();
      return;
    }
    const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
    if (!this.drag.moved && Math.hypot(e.clientX - this.drag.x, e.clientY - this.drag.y) < 4) return;
    if (!this.drag.moved) {
      this.drag.moved = true;
      this.cv.classList.add('dragging');
      this.setHover(null, 0, 0);
    }
    this.view = { ...this.view, tx: this.view.tx + dx, ty: this.view.ty + dy };
    this.invalidate();
  };

  private onUp = (e: PointerEvent) => {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    if (this.pointers.size) return;
    const drag = this.drag;
    this.drag = null;
    this.cv.classList.remove('dragging');
    if (drag && !drag.moved && e.type === 'pointerup') this.hooks.select(this.pick(e.clientX, e.clientY));
  };

  // ---------- drawing ----------

  invalidate() {
    if (!this.frame) this.frame = requestAnimationFrame(this.draw);
  }

  private draw = (now: number) => {
    this.frame = 0;
    if (this.anim) {
      const { from, to, t0, ms } = this.anim;
      const t = Math.min(1, (now - t0) / ms), e = 1 - (1 - t) ** 3;
      this.view = { s: from.s + (to.s - from.s) * e, tx: from.tx + (to.tx - from.tx) * e, ty: from.ty + (to.ty - from.ty) * e };
      if (t >= 1) this.anim = null;
    }
    const { ctx, data } = this;
    const { s, tx, ty } = this.view;
    const X = (x: number) => x * s + tx, Y = (y: number) => y * s + ty;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, this.W, this.H);

    const focusMode = this.highlighted !== null || this.rec !== null || this.chat !== null;
    const chatSet = new Set(this.chat?.films ?? []);
    const recSet = new Set(this.rec ? [...this.rec.results.map(r => r.film), ...this.rec.like, ...this.rec.dislike] : []);

    // Nebula: a faint glow over each kind.
    data.kinds.forEach((k, i) => {
      const cx = X(k.cx), cy = Y(k.cy), r = k.r * s * 1.7;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, `rgba(${this.kindRgb[i]},${focusMode ? 0.03 : 0.07})`);
      g.addColorStop(1, `rgba(${this.kindRgb[i]},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    });

    // Faint threads between kinds.
    if (!focusMode) {
      ctx.lineWidth = 0.6;
      for (const [a, b] of data.edges) {
        if (!this.visible[a] || !this.visible[b]) continue;
        const fa = data.films[a], fb = data.films[b];
        ctx.strokeStyle = `rgba(${hexRgb(fa.color)},0.07)`;
        ctx.beginPath();
        ctx.moveTo(X(fa.x), Y(fa.y));
        ctx.lineTo(X(fb.x), Y(fb.y));
        ctx.stroke();
      }
    }

    // Dots, added together for a soft glow where they crowd.
    const base = this.base();
    ctx.globalCompositeOperation = 'lighter';
    let style = '';
    for (const i of this.order) {
      if (!this.visible[i]) continue;
      const f = data.films[i], x = X(f.x), y = Y(f.y), r = base * this.sizeMul[i];
      if (x < -r || y < -r || x > this.W + r || y > this.H + r) continue;
      let alpha = 0.85;
      if (this.highlighted && !this.highlighted[i]) alpha = 0.1;
      if (this.rec && !recSet.has(i)) alpha = Math.min(alpha, 0.25);
      if (this.chat && !chatSet.has(i)) alpha = Math.min(alpha, 0.22);
      if (f.color !== style) ctx.fillStyle = style = f.color;
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    const boxes: Box[] = [];
    const titles: [number, string, number][] = []; // film, colour, alpha — drawn after the overlays

    // Recommend view: threads from each result back to the pick that led to it.
    if (this.rec) {
      for (const r of this.rec.results) {
        const a = data.films[r.film], b = data.films[r.from];
        ctx.strokeStyle = `rgba(${this.kindRgb[a.kind]},0.55)`;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(X(a.x), Y(a.y));
        ctx.lineTo(X(b.x), Y(b.y));
        ctx.stroke();
      }
      for (const i of this.rec.like) this.halo(X(data.films[i].x), Y(data.films[i].y), '255,255,255', 22, 0.5);
      for (const i of [...this.rec.like, ...this.rec.dislike]) {
        const f = data.films[i];
        this.dot(X(f.x), Y(f.y), base * 2.2 + 1, f.color, this.rec.dislike.includes(i) ? '#e5484d' : '#fff', 2);
        titles.push([i, '#fff', 1]);
      }
      for (const r of this.rec.results) {
        const f = data.films[r.film], x = X(f.x), y = Y(f.y);
        ctx.strokeStyle = data.kinds[f.kind].color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, base * this.sizeMul[r.film] + 4, 0, Math.PI * 2);
        ctx.stroke();
        titles.push([r.film, '#e7e9ee', 0.9]);
      }
    }

    // Chat results: a gold halo, a ring and a numbered badge (badges are drawn last, on top).
    if (this.chat) {
      const pulse = reducedMotion() ? 0.55 : 0.5 + 0.12 * Math.sin(now / 500);
      this.chat.films.forEach(i => {
        const f = data.films[i], x = X(f.x), y = Y(f.y), hot = i === this.chat!.hover;
        this.halo(x, y, '255,211,110', hot ? 38 : 30, hot ? 0.8 : pulse);
        this.dot(x, y, Math.max(5.5, base * this.sizeMul[i] * 1.6), f.color, hot ? '#fff' : '#ffd36e', hot ? 2.5 : 1.8);
        titles.push([i, '#fff', 1]);
      });
    }

    // The selected film and its nearest films.
    if (this.selected !== null) {
      const f = data.films[this.selected], x = X(f.x), y = Y(f.y);
      for (const [j, m] of this.neighbours) {
        const n = data.films[j];
        ctx.strokeStyle = j === this.hoverNb ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.35)';
        ctx.lineWidth = 1 + ((m - 55) / 12) * 0.45;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(X(n.x), Y(n.y));
        ctx.stroke();
      }
      for (const [j] of this.neighbours) {
        const n = data.films[j];
        this.dot(X(n.x), Y(n.y), Math.max(4, base * this.sizeMul[j] * 1.8), n.color, '#fff', j === this.hoverNb ? 2.2 : 1.5);
      }
      const pulse = reducedMotion() ? 0.5 : 0.5 + 0.18 * Math.sin(now / 420);
      this.halo(x, y, this.kindRgb[f.kind], 26, pulse);
      this.dot(x, y, Math.max(6, base * this.sizeMul[this.selected] * 2.4), data.kinds[f.kind].color, '#fff', 2);
      titles.unshift([this.selected, '#fff', 1], ...this.neighbours.map(([j]): [number, string, number] => [j, '#e7e9ee', j === this.hoverNb ? 1 : 0.85]));
    }

    // Hover ring.
    if (this.hovered !== null && this.hovered !== this.selected) {
      const f = data.films[this.hovered];
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(X(f.x), Y(f.y), this.dotRadius(this.hovered) + 3, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Labels: picked titles first, then kinds, sub-clusters and (zoomed in) film titles.
    for (const [i, c, a] of titles) {
      const f = data.films[i];
      const big = i === this.selected;
      const dy = big ? -16 : 12 + this.dotRadius(i);
      this.label(f.title, X(f.x), Y(f.y) + (big ? dy : dy - 4), big ? 12.5 : 10.5, c, big ? 650 : 500, a, boxes, big);
    }
    if (this.showLabels) {
      const z = this.zoom;
      const kindAlpha = z < 1.6 ? 1 : Math.max(0.25, 1 - (z - 1.6) / 2.5);
      data.kinds.forEach(k => {
        const d = Math.hypot(k.cx, k.cy) || 1;
        const lx = X(k.cx + (k.cx / d) * k.r * 1.02), ly = Y(k.cy + (k.cy / d) * k.r * 1.02);
        this.label(k.name, lx, ly, Math.min(20, 13 + 2 * z), k.color, 650, kindAlpha * (focusMode ? 0.6 : 1), boxes, this.selected === null && !this.rec && !this.chat);
      });
      if (z > 0.85) {
        const subAlpha = Math.min(0.6, (z - 0.85) * 2) * (focusMode ? 0.6 : 1);
        const subs = [...data.subs].sort((a, b) => b.size - a.size);
        for (const sb of subs) this.label(sb.name, X(sb.cx), Y(sb.cy), Math.min(13, 9.5 + z * 0.8), '#e7e9ee', 500, subAlpha, boxes, false);
      }
      if (z > 3) {
        const cands = data.films
          .filter(f => this.pickable(f.i))
          .map(f => ({ f, x: X(f.x), y: Y(f.y) }))
          .filter(({ x, y }) => x > 0 && y > 0 && x < this.W && y < this.H)
          .sort((a, b) => b.f.pop - a.f.pop)
          .slice(0, 400);
        let n = 0;
        for (const { f, x, y } of cands) {
          if (n >= 160) break;
          if (this.label(f.title, x, y + 9 + this.dotRadius(f.i), 10.5, '#cfd3dd', 500, Math.min(0.8, (z - 3) * 0.8), boxes, false)) n++;
        }
      }
    }

    if (this.chat)
      this.chat.films.forEach((i, n) => {
        const f = data.films[i], bx = X(f.x) + 9, by = Y(f.y) - 9;
        ctx.fillStyle = '#ffd36e';
        ctx.beginPath();
        ctx.arc(bx, by, 7.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#14161d';
        ctx.font = `700 9.5px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(n + 1), bx, by + 0.5);
      });

    if (this.anim || ((this.selected !== null || this.chat) && !reducedMotion())) this.invalidate();
  };

  private dot(x: number, y: number, r: number, fill: string, ring: string, w: number) {
    const { ctx } = this;
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = ring;
    ctx.lineWidth = w;
    ctx.stroke();
  }

  private halo(x: number, y: number, rgb: string, r: number, a: number) {
    const { ctx } = this;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${rgb},${a})`);
    g.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  /** Draws a label unless it would overlap one already placed (or `force`). Returns whether it drew. */
  private label(text: string, x: number, y: number, size: number, color: string, weight: number, alpha: number, boxes: Box[], force: boolean) {
    if (alpha <= 0.01) return false;
    const { ctx } = this;
    ctx.font = `${weight} ${size}px ${FONT}`;
    const w = ctx.measureText(text).width, h = size + 2;
    const box: Box = [x - w / 2 - 2, y - h / 2, x + w / 2 + 2, y + h / 2];
    if (box[2] < 0 || box[0] > this.W || box[3] < 0 || box[1] > this.H) return false;
    if (!force && boxes.some(b => b[0] < box[2] && box[0] < b[2] && b[1] < box[3] && box[1] < b[3])) return false;
    boxes.push(box);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.globalAlpha = alpha;
    ctx.lineJoin = 'round';
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(10,11,15,0.92)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
    ctx.globalAlpha = 1;
    return true;
  }
}
