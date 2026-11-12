// The chat dock at the bottom centre (plans/chat-discovery.md 1.1): sends the conversation to
// /api/chat, streams the answer, turns [n] markers into film chips and tells the page which films
// to light up. The conversation lives in sessionStorage, so a reload keeps it.
import type { Film } from './data';

export interface ChatResult {
  film: number; // film index
  source: 'wikipedia' | 'tags';
}

export interface ChatHooks {
  picks(): { like: number[]; dislike: number[] }; // TMDB ids
  results(films: ChatResult[], question: string): void;
  why(n: number, text: string): void;
  clear(): void;
  open(film: number): void;
  hover(film: number | null): void;
}

interface Turn {
  role: 'user' | 'assistant';
  text: string;
  /** assistant turns: the films its [n] markers refer to (film indices) */
  films?: number[];
  sources?: ChatResult['source'][];
  whys?: Record<number, string>;
  badges?: string[];
  error?: boolean;
}

interface Saved {
  turns: Turn[];
  state: { query: unknown; results: number[] } | null;
  suggestions: string[];
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const STEP: Record<string, string> = { understanding: 'Understanding…', searching: 'Searching the map…', writing: 'Writing…' };
const KEY = 'rg-chat';

export class Chat {
  private turns: Turn[] = [];
  private state: Saved['state'] = null;
  private suggestions: string[] = [];
  private busy: AbortController | null = null;
  private thread = $('chat-thread');
  private input = $<HTMLInputElement>('chat-input');
  private root = $('chat');

  constructor(private films: Film[], private hooks: ChatHooks) {
    $('chat-form').addEventListener('submit', e => {
      e.preventDefault();
      void this.send(this.input.value);
    });
    $('chat-clear').onclick = () => this.clear();
    $('chat-min').onclick = () => this.root.classList.toggle('min');
    this.input.addEventListener('focus', () => this.root.classList.remove('min'));
    this.input.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        this.input.blur();
        e.stopPropagation();
      }
    });
    this.thread.addEventListener('click', e => {
      const t = e.target as HTMLElement;
      const ref = t.closest<HTMLElement>('.ref');
      if (ref) this.hooks.open(Number(ref.dataset.i));
      if (t.closest('.retry')) this.retry();
    });
    this.thread.addEventListener('mouseover', e => {
      const ref = (e.target as HTMLElement).closest<HTMLElement>('.ref');
      this.hooks.hover(ref ? Number(ref.dataset.i) : null);
    });
    this.thread.addEventListener('mouseleave', () => this.hooks.hover(null));
    $('chat-sugg').addEventListener('click', e => {
      const b = (e.target as HTMLElement).closest('button');
      if (b) void this.send(b.textContent ?? '');
    });
    this.restore();
  }

  focus() {
    this.root.classList.remove('min');
    this.input.focus();
  }

  get active() {
    return this.turns.length > 0;
  }

  // ---------- sending ----------

  async send(raw: string) {
    const text = raw.trim().slice(0, 500);
    if (!text || this.busy) return;
    this.input.value = '';
    this.turns.push({ role: 'user', text });
    const ai: Turn = { role: 'assistant', text: '' };
    this.turns.push(ai);
    this.suggestions = [];
    this.render();
    await this.stream(ai, text);
  }

  private retry() {
    const last = this.turns[this.turns.length - 1], user = this.turns[this.turns.length - 2];
    if (!last?.error || !user || this.busy) return;
    this.turns.splice(-2, 2);
    void this.send(user.text);
  }

  private async stream(ai: Turn, question: string) {
    const ctrl = new AbortController();
    this.busy = ctrl;
    ($('chat-send') as HTMLButtonElement).disabled = true;
    this.setStep('understanding');
    const messages = this.turns
      .slice(0, -1)
      .filter(t => !t.error && t.text)
      .slice(-12)
      .map(t => ({ role: t.role, text: t.text }));
    let res: Response;
    try {
      res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages, state: this.state, picks: this.hooks.picks() }),
        signal: ctrl.signal,
      });
    } catch {
      if (!ctrl.signal.aborted) this.fail(ai, 'Couldn’t reach the server.');
      return this.finish(ctrl);
    }
    if (!res.ok || !res.body) {
      const msg = await res.json().then((j: { error?: string }) => j.error, () => null);
      this.fail(ai, msg ?? `The server answered ${res.status}.`);
      return this.finish(ctrl);
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let end;
        while ((end = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, end);
          buf = buf.slice(end + 2);
          const event = /^event: (.+)$/m.exec(block)?.[1];
          const data = JSON.parse(/^data: (.+)$/m.exec(block)?.[1] ?? 'null');
          this.onEvent(ai, event ?? '', data, question);
        }
      }
    } catch {
      if (!ctrl.signal.aborted && !ai.text) this.fail(ai, 'The answer was cut off.');
    }
    this.finish(ctrl);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private onEvent(ai: Turn, event: string, data: any, question: string) {
    if (event === 'step') this.setStep(data.step);
    else if (event === 'results') {
      ai.badges = [data.model ?? 'local model', data.searched ? `searched ${data.searched.toLocaleString('en-US')} films` : ''].filter(Boolean);
      if (data.offline) ai.badges = ['assistant offline · keyword search'];
      if (data.films) {
        const byId = new Map(this.films.map(f => [f.id, f.i]));
        const results: ChatResult[] = data.films
          .map((f: { id: number; source: ChatResult['source'] }) => ({ film: byId.get(f.id), source: f.source }))
          .filter((r: { film?: number }) => r.film !== undefined);
        ai.films = results.map(r => r.film);
        ai.sources = results.map(r => r.source);
        ai.whys = {};
        this.hooks.results(results, question);
      }
      this.renderTurn(ai);
    } else if (event === 'text') {
      ai.text += data.text;
      this.renderTurn(ai);
    } else if (event === 'why') {
      (ai.whys ??= {})[data.n] = data.text;
      this.hooks.why(data.n, data.text);
    } else if (event === 'done') {
      this.suggestions = data.suggestions ?? [];
      this.state = data.state ? { query: data.state.query, results: data.state.results } : this.state;
    } else if (event === 'error') this.fail(ai, data.message, data.offline);
  }

  private fail(ai: Turn, message: string, offline = false) {
    ai.error = true;
    ai.text = message + (offline ? ' The map and normal search still work.' : '');
    this.renderTurn(ai);
  }

  private finish(ctrl: AbortController) {
    if (this.busy === ctrl) this.busy = null;
    ($('chat-send') as HTMLButtonElement).disabled = false;
    this.setStep(null);
    this.render();
    this.save();
  }

  clear() {
    this.busy?.abort();
    this.busy = null;
    this.turns = [];
    this.state = null;
    this.suggestions = [];
    sessionStorage.removeItem(KEY);
    this.render();
    this.hooks.clear();
  }

  // ---------- rendering ----------

  private stepEl: HTMLElement | null = null;

  private setStep(step: string | null) {
    const ai = this.turns[this.turns.length - 1];
    if (!ai || ai.role !== 'assistant') return;
    this.stepEl?.remove();
    this.stepEl = null;
    if (step && !ai.text) {
      const el = this.thread.lastElementChild as HTMLElement | null;
      if (!el) return;
      this.stepEl = document.createElement('div');
      this.stepEl.className = 'thinking';
      this.stepEl.innerHTML = `<i></i><i></i><i></i>${STEP[step] ?? ''}`;
      el.append(this.stepEl);
    }
    $('chat-status').textContent = step ? (STEP[step] ?? '') : '';
  }

  /** The reply as HTML: [n] markers become chips; a title written right before its marker is folded into the chip. */
  private body(t: Turn, current: boolean) {
    let text = t.text.replace(/\*\*|__/g, '').replace(/^\s*REPLY\s*:\s*/i, '').replace(/\[\[(\d+)\]\]/g, '[$1]');
    const films = t.films ?? [];
    films.forEach((f, k) => {
      const title = this.films[f].title;
      text = text.replace(new RegExp(`["“*_]?${reEsc(title)}["”*_]?(?:\\s*\\(\\d{4}\\))?\\s*\\[${k + 1}\\]`, 'gi'), `[${k + 1}]`);
    });
    return esc(text).replace(/\[(\d+)\]/g, (m, n) => {
      const f = films[Number(n) - 1];
      return f === undefined ? m : `<button type="button" class="ref${current ? '' : ' old'}" data-i="${f}"><i>${n}</i>${esc(this.films[f].title)}</button>`;
    });
  }

  private renderTurn(t: Turn) {
    const n = this.turns.indexOf(t);
    const el = this.thread.children[n] as HTMLElement | undefined;
    if (!el) return this.render();
    el.innerHTML = this.turnHtml(t, n);
    if (this.stepEl && !t.text) el.append(this.stepEl);
    this.thread.scrollTop = this.thread.scrollHeight;
  }

  private turnHtml(t: Turn, n: number) {
    if (t.role === 'user') return esc(t.text);
    const lastAi = this.turns.map(x => x.role).lastIndexOf('assistant') === n;
    const who = `<div class="who">reelgraph${(t.badges ?? []).map(b => `<span class="badge${b.includes('offline') ? ' warn' : ''}">${esc(b)}</span>`).join('')}</div>`;
    if (t.error) return `${who}${esc(t.text)}${lastAi ? '<button type="button" class="retry">Retry</button>' : ''}`;
    return who + this.body(t, lastAi);
  }

  private render() {
    const has = this.turns.length > 0;
    this.root.classList.toggle('fresh', !has);
    $('chat-thread').hidden = !has;
    $('chat-top').hidden = !has;
    $('chat-clear').hidden = !has;
    this.input.placeholder = has ? 'Ask for a film, or refine…' : 'Ask for a film… e.g. a movie where a rich lifestyle is shown';
    this.thread.innerHTML = this.turns.map((t, n) => `<div class="msg ${t.role === 'user' ? 'me' : 'ai'}${t.error ? ' err' : ''}">${this.turnHtml(t, n)}</div>`).join('');
    const sugg = $('chat-sugg');
    sugg.hidden = !this.suggestions.length || !!this.busy;
    sugg.innerHTML = this.suggestions.map(s => `<button type="button">${esc(s)}</button>`).join('');
    this.thread.scrollTop = this.thread.scrollHeight;
  }

  // ---------- persistence ----------

  private save() {
    const saved: Saved = { turns: this.turns, state: this.state, suggestions: this.suggestions };
    try {
      sessionStorage.setItem(KEY, JSON.stringify(saved));
    } catch {}
  }

  private restore() {
    try {
      const s = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as Saved | null;
      if (!s?.turns?.length) return this.render();
      // A reply cut off by a reload is dropped with its question.
      const last = s.turns[s.turns.length - 1];
      if (last.role === 'assistant' && !last.text) s.turns.splice(-2, 2);
      this.turns = s.turns.filter(t => !t.films || t.films.every(f => this.films[f]));
      this.state = s.state;
      this.suggestions = s.suggestions ?? [];
    } catch {
      this.turns = [];
    }
    this.render();
    const ai = [...this.turns].reverse().find(t => t.role === 'assistant' && t.films?.length);
    if (ai) {
      const q = this.turns[this.turns.indexOf(ai) - 1]?.text ?? '';
      this.hooks.results(ai.films!.map((f, k) => ({ film: f, source: ai.sources?.[k] ?? 'tags' })), q);
      for (const [n, text] of Object.entries(ai.whys ?? {})) this.hooks.why(Number(n), text);
    }
  }
}
