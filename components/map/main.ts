// The map page: loads the data, starts the canvas and wires the search, highlight chips, filters,
// film card, similar list and recommend tray. Markup is in app/page.tsx.
import { IMG, langName, loadJson, loadMap, type Detail, type MapData, type Tags } from './data';
import { matchOf, recommend, shared, toVec, type Rec, type Vec } from './recommend';
import { Chat, type ChatResult } from './Chat';
import { VectorMap } from './VectorMap';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const fmt = (n: number) => n.toLocaleString('en-US');
const mobile = () => matchMedia('(max-width: 640px)').matches;

type ChipType = 'genre' | 'keyword' | 'director' | 'kind';
interface Highlight { type: ChipType; key: number; label: string }

let data: MapData;
try {
  data = await loadMap();
} catch {
  $('loading').classList.add('done');
  $('error').hidden = false;
  throw new Error('map data missing: run npm run data');
}

const N = data.films.length;
let details: Detail[] | null = null;
let tags: Tags | null = null;
let vecs: Vec[] = [];

let highlights: Highlight[] = [];
let mode: 'or' | 'and' = 'or';
const activeLangs = new Set(data.languages.map(l => l.code));
let trail: number[] = [];
let like: number[] = [];
let dislike: number[] = [];
let recResults: Rec[] | null = null;

const live = (msg: string) => ($('live').textContent = msg);

// ---------- canvas ----------

const tooltip = $('tooltip');
const map = new VectorMap($('cv') as HTMLCanvasElement, data, {
  hover(i, x, y) {
    if (i === null) {
      tooltip.hidden = true;
      return;
    }
    const f = data.films[i], k = data.kinds[f.kind];
    const genres = (details?.[i].chips ?? []).filter(([d]) => d >= 0 && tags?.vocab[d][0].startsWith('g:')).map(c => c[1]).slice(0, 3);
    tooltip.innerHTML =
      `<div class="t-title">${esc(f.title)}</div>` +
      `<div class="t-sub">${f.year} · ${langName(f.lang)}${genres.length ? ' · ' + esc(genres.join(', ')) : ''}</div>` +
      `<div class="t-sub" style="color:${k.color}">${esc(k.name)} · ${esc(data.subs[f.sub].name)}</div>`;
    tooltip.hidden = false;
    const w = tooltip.offsetWidth, h = tooltip.offsetHeight;
    tooltip.style.left = `${Math.min(innerWidth - w - 8, x + 14)}px`;
    tooltip.style.top = `${Math.max(8, y - h - 10)}px`;
  },
  select(i) {
    if (i === null) return;
    openFilm(i);
  },
});

// ---------- panels ----------

function setInsets() {
  const d = $('detail').classList.contains('open'), p = $('panel').classList.contains('open');
  map.insets = mobile()
    ? { left: 0, right: 0, top: d ? innerHeight * 0.35 : 0, bottom: p ? innerHeight * 0.25 : 0 }
    : { left: d ? 340 : 0, right: p ? 330 : 0, top: 0, bottom: chatHeight() };
  $('controls').classList.toggle('shifted', d);
  $('hint').classList.toggle('shifted', d);
  $('zoom').classList.toggle('shifted', p);
  const st = document.body.style, m = mobile();
  st.setProperty('--l', `${m ? 0 : map.insets.left}px`);
  st.setProperty('--r', `${m ? 0 : map.insets.right}px`);
  st.setProperty('--b', `${map.insets.bottom}px`);
}

/** Room the chat dock takes at the bottom, so fits and centring keep films out from under it. */
function chatHeight() {
  const el = document.getElementById('chat');
  return el ? el.offsetHeight + 24 : 0;
}

function openFilm(i: number, { push = true, center = true } = {}) {
  if (recResults) exitRecommend(false);
  if (push && trail[trail.length - 1] !== i) trail.push(i);
  map.selected = i;
  map.neighbours = details ? details[i].nb.map(([j, m]) => [j, m]) : [];
  map.hoverNb = null;
  renderCard(i);
  renderSimilar(i);
  $('p-back').hidden = !chatResults;
  $('detail').classList.add('open');
  $('panel').classList.add('open');
  setInsets();
  if (center) map.centerOn(i);
  map.invalidate();
  const url = new URL(location.href);
  url.searchParams.set('film', String(data.films[i].id));
  history.replaceState(null, '', url);
  live(`${data.films[i].title}, ${data.films[i].year}. ${map.neighbours.length} similar films listed.`);
}

function closePanels() {
  trail = [];
  map.selected = null;
  map.neighbours = [];
  $('detail').classList.remove('open');
  if (chatResults && !recResults) showChat(false);
  else if (!recResults) $('panel').classList.remove('open');
  setInsets();
  map.invalidate();
  const url = new URL(location.href);
  url.searchParams.delete('film');
  history.replaceState(null, '', url);
}

function back() {
  if (trail.length > 1) {
    trail.pop();
    openFilm(trail[trail.length - 1], { push: false });
  } else closePanels();
}

function renderCard(i: number) {
  const f = data.films[i], k = data.kinds[f.kind], d = details?.[i];
  const poster = $<HTMLImageElement>('d-poster');
  poster.src = `${IMG}w342${f.poster}`;
  poster.alt = `Poster for ${f.title}`;
  $('d-title').textContent = f.title;
  $('d-meta').textContent = [f.year, langName(f.lang), d?.director && `dir. ${d.director}`, d && `★ ${d.rating.toFixed(1)}`].filter(Boolean).join(' · ');
  $('d-kind').innerHTML = `<span style="color:${k.color}">${esc(k.name)} · ${esc(data.subs[f.sub].name)}</span>`;
  $('d-overview').textContent = d?.overview ?? '';
  const chips = $('d-chips');
  chips.innerHTML = '';
  for (const [dim, text] of d?.chips ?? []) {
    const key = tags?.vocab[dim]?.[0] ?? '';
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `chip ${key.startsWith('g:') ? 'g' : 'k'}`;
    b.textContent = key.startsWith('g:') ? text : text.toLowerCase();
    if (dim < 0) b.disabled = true;
    else b.onclick = () => addHighlight(key.startsWith('g:') ? 'genre' : 'keyword', dim, text);
    chips.append(b);
  }
  const imdb = $<HTMLAnchorElement>('d-imdb');
  imdb.hidden = !d?.imdb;
  if (d?.imdb) imdb.href = `https://www.imdb.com/title/${d.imdb}/`;
  syncLikeButtons();
}

function simRow(j: number, pct: number, reasons: string, onHover: (on: boolean) => void) {
  const n = data.films[j];
  const li = document.createElement('li');
  li.innerHTML =
    `<button type="button" class="sim"><img src="${IMG}w92${n.poster}" alt="" loading="lazy">` +
    `<span class="mid"><span class="t"><span class="dot" style="background:${data.kinds[n.kind].color}"></span>` +
    `<span class="nm">${esc(n.title)}</span> <span class="y">${n.year}</span></span>` +
    `<span class="r">${reasons}</span></span><span class="pct">${pct}%</span></button>`;
  const b = li.firstElementChild as HTMLButtonElement;
  b.onclick = () => openFilm(j);
  b.onmouseenter = b.onfocus = () => onHover(true);
  b.onmouseleave = b.onblur = () => onHover(false);
  return li;
}

function panelHead(title: string, right: string, sub = '') {
  $('p-title').textContent = title;
  $('p-right').textContent = right;
  $('p-sub').textContent = sub;
  $('p-sub').hidden = !sub;
  $('p-back').hidden = true;
}

function renderSimilar(i: number) {
  panelHead('Similar films', 'match');
  const list = $('p-list');
  list.innerHTML = '';
  if (!details) {
    list.innerHTML = '<li class="sim"><span class="r">Loading similar films…</span></li>';
    return;
  }
  for (const [j, m, reasons] of details[i].nb)
    list.append(
      simRow(j, m, esc(reasons.join(' · ')), on => {
        map.hoverNb = on ? j : null;
        map.invalidate();
      }),
    );
}

// ---------- highlight chips, languages, kinds ----------

let filmDims: Set<number>[] = [];

function addHighlight(type: ChipType, key: number, label: string) {
  if (highlights.some(h => h.type === type && h.key === key)) return;
  highlights.push({ type, key, label });
  recompute();
}

function removeHighlight(h: Highlight) {
  highlights = highlights.filter(x => x !== h);
  recompute();
}

function matches(i: number, h: Highlight) {
  return h.type === 'kind' ? data.films[i].kind === h.key : (filmDims[i]?.has(h.key) ?? false);
}

function recompute() {
  map.visible = Uint8Array.from(data.films, f => (activeLangs.has(f.lang) ? 1 : 0));
  let shown = 0, lit = 0;
  if (highlights.length) {
    const hl = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      const ok = mode === 'or' ? highlights.some(h => matches(i, h)) : highlights.every(h => matches(i, h));
      hl[i] = ok ? 1 : 0;
      if (ok && map.visible[i]) lit++;
    }
    map.highlighted = hl;
  } else map.highlighted = null;
  for (let i = 0; i < N; i++) shown += map.visible[i];
  $('counter').innerHTML =
    `${fmt(shown)} films` +
    (highlights.length ? ` · ${fmt(lit)} highlighted` : '') +
    (chatResults?.length ? ` · <b class="from-chat">${chatResults.length} from chat</b>` : '');
  renderChips();
  map.invalidate();
}

function renderChips() {
  const box = $('chips');
  box.innerHTML = '';
  for (const h of highlights) {
    const el = document.createElement('span');
    el.className = `hl-chip ${h.type === 'genre' || h.type === 'kind' ? 'genre' : 'keyword'}`;
    const sw = h.type === 'kind' ? `<span class="sw" style="background:${data.kinds[h.key].color}"></span>` : '';
    el.innerHTML = `${sw}<span>${esc(h.type === 'director' ? `dir. ${h.label}` : h.label)}</span><button type="button" class="x" aria-label="Remove ${esc(h.label)}">×</button>`;
    (el.querySelector('.x') as HTMLButtonElement).onclick = () => removeHighlight(h);
    box.append(el);
  }
  $('match-toggle').classList.toggle('show', highlights.length > 1);
  document.querySelectorAll('.kind-row').forEach((r, k) => r.classList.toggle('on', highlights.some(h => h.type === 'kind' && h.key === k)));
}

$('mode-or').onclick = () => setMode('or');
$('mode-and').onclick = () => setMode('and');
function setMode(m: 'or' | 'and') {
  mode = m;
  $('mode-or').classList.toggle('active', m === 'or');
  $('mode-and').classList.toggle('active', m === 'and');
  recompute();
}

for (const box of ['lang-box', 'kind-box']) {
  const el = $(box), head = el.querySelector('.ctl-head') as HTMLButtonElement;
  head.onclick = () => {
    el.classList.toggle('collapsed');
    head.setAttribute('aria-expanded', String(!el.classList.contains('collapsed')));
  };
}

$('lang-list').innerHTML = data.languages
  .map(l => `<label class="lang-row"><input type="checkbox" data-lang="${l.code}" checked><span>${langName(l.code)}</span><span class="l-count">${fmt(l.count)}</span></label>`)
  .join('');
const syncLangs = () => document.querySelectorAll<HTMLInputElement>('#lang-list input').forEach(cb => (cb.checked = activeLangs.has(cb.dataset.lang!)));
$('lang-list').addEventListener('change', e => {
  const cb = e.target as HTMLInputElement;
  if (cb.checked) activeLangs.add(cb.dataset.lang!);
  else activeLangs.delete(cb.dataset.lang!);
  recompute();
});
$('lang-all').onclick = () => {
  data.languages.forEach(l => activeLangs.add(l.code));
  syncLangs();
  recompute();
};
$('lang-none').onclick = () => {
  activeLangs.clear();
  syncLangs();
  recompute();
};

$('kind-head').textContent = `Kinds · ${data.kinds.length}`;
data.kinds.forEach((k, i) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'kind-row';
  b.innerHTML = `<span class="sw" style="background:${k.color}"></span>${esc(k.name)}<span class="k-count">${fmt(k.count)}</span>`;
  b.onclick = () => {
    const h = highlights.find(x => x.type === 'kind' && x.key === i);
    if (h) removeHighlight(h);
    else addHighlight('kind', i, k.name);
  };
  $('kind-list').append(b);
});

// ---------- search ----------

interface Result { kind: 'film' | ChipType; label: string; key: number; extra: string; via?: string }
const search = $<HTMLInputElement>('search'), results = $('results');
let shownResults: Result[] = [];
let active = -1;

function runSearch(raw: string): Result[] {
  const q = raw.trim().toLowerCase();
  if (!q) return [];
  const rank = (s: string) => {
    const l = s.toLowerCase(), at = l.indexOf(q);
    return at < 0 ? -1 : at === 0 ? 0 : /\W/.test(l[at - 1]) ? 1 : 2;
  };
  const films = data.films
    .map(f => ({ f, r: rank(f.title) }))
    .filter(x => x.r >= 0)
    .sort((a, b) => a.r - b.r || b.f.pop - a.f.pop)
    .slice(0, 6)
    .map(({ f }): Result => ({ kind: 'film', label: f.title, key: f.i, extra: String(f.year) }));
  const kinds = data.kinds
    .map((k, i) => ({ k, i, r: rank(k.name) }))
    .filter(x => x.r >= 0)
    .map(({ k, i }): Result => ({ kind: 'kind', label: k.name, key: i, extra: fmt(k.count) }));
  const vocab = (prefix: string, kind: ChipType, minDf: number, max: number) =>
    (tags?.vocab ?? [])
      .map(([key, label, df], dim) => ({ key, label, df, dim, r: key.startsWith(prefix) && df >= minDf ? rank(label) : -1 }))
      .filter(x => x.r >= 0)
      .sort((a, b) => a.r - b.r || b.df - a.df)
      .slice(0, max)
      .map((x): Result => ({ kind, label: x.label, key: x.dim, extra: fmt(x.df) }));
  const via: Result[] = [];
  if (details && q.length >= 3) {
    const seen = new Set(films.map(r => r.key));
    for (const f of [...data.films].sort((a, b) => b.pop - a.pop)) {
      if (via.length >= 3) break;
      if (seen.has(f.i)) continue;
      const d = details[f.i];
      const who = [d.director ?? '', ...d.cast].find(n => rank(n) >= 0 && rank(n) < 2);
      if (who) via.push({ kind: 'film', label: f.title, key: f.i, extra: String(f.year), via: who });
    }
  }
  return [...films, ...kinds, ...vocab('g:', 'genre', 1, 3), ...vocab('k:', 'keyword', 3, 4), ...vocab('d:', 'director', 2, 2), ...via].slice(0, 12);
}

const TAG: Record<Result['kind'], [string, string]> = {
  film: ['film', 'tag-film'],
  kind: ['kind', 'tag-genre'],
  genre: ['genre', 'tag-genre'],
  keyword: ['keyword', 'tag-keyword'],
  director: ['director', 'tag-keyword'],
};

function showResults() {
  shownResults = runSearch(search.value);
  active = shownResults.length ? 0 : -1;
  results.innerHTML = shownResults
    .map(
      (r, n) =>
        `<div class="res-row${n === active ? ' active' : ''}" role="option" data-n="${n}"><span class="res-tag ${TAG[r.kind][1]}">${TAG[r.kind][0]}</span>` +
        `<span class="r-name">${esc(r.label)}</span>${r.via ? `<span class="r-via">via ${esc(r.via)}</span>` : ''}` +
        `<span class="${r.kind === 'film' ? 'r-year' : 'r-count'}">${esc(r.extra)}</span></div>`,
    )
    .join('');
  if (search.value.trim() && !shownResults.length) results.innerHTML = `<div class="res-row" style="color:var(--muted)">${tags ? 'No matches' : 'Loading tags…'}</div>`;
  results.classList.toggle('show', search.value.trim().length > 0);
  search.setAttribute('aria-expanded', String(results.classList.contains('show')));
}

function choose(n: number) {
  const r = shownResults[n];
  if (!r) return;
  search.value = '';
  results.classList.remove('show');
  search.blur();
  if (r.kind === 'film') {
    const f = data.films[r.key];
    if (!activeLangs.has(f.lang)) {
      activeLangs.add(f.lang);
      syncLangs();
      recompute();
    }
    openFilm(r.key);
  } else addHighlight(r.kind, r.key, r.label);
}

search.addEventListener('input', showResults);
search.addEventListener('focus', () => search.value && showResults());
search.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!shownResults.length) return;
    active = (active + (e.key === 'ArrowDown' ? 1 : shownResults.length - 1)) % shownResults.length;
    results.querySelectorAll('.res-row').forEach((el, n) => el.classList.toggle('active', n === active));
    results.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') choose(active);
  else if (e.key === 'Escape') {
    search.value = '';
    results.classList.remove('show');
    search.blur();
    e.stopPropagation();
  }
});
results.addEventListener('mousedown', e => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('.res-row[data-n]');
  if (row) {
    e.preventDefault();
    choose(Number(row.dataset.n));
  }
});
search.addEventListener('blur', () => setTimeout(() => results.classList.remove('show'), 120));

// ---------- picks and recommendations ----------

const MAX_PICKS = 5;
const byId = new Map(data.films.map(f => [f.id, f.i]));

function savePicks() {
  const ids = (l: number[]) => l.map(i => data.films[i].id).join(',');
  localStorage.setItem('rg-picks', JSON.stringify({ like: ids(like), dislike: ids(dislike) }));
  const url = new URL(location.href);
  for (const [k, l] of [['like', like], ['dislike', dislike]] as const) {
    if (l.length) url.searchParams.set(k, ids(l));
    else url.searchParams.delete(k);
  }
  history.replaceState(null, '', url);
}

function loadPicks() {
  const url = new URL(location.href);
  let src: { like?: string; dislike?: string } = {};
  if (url.searchParams.has('like') || url.searchParams.has('dislike')) src = { like: url.searchParams.get('like') ?? '', dislike: url.searchParams.get('dislike') ?? '' };
  else
    try {
      src = JSON.parse(localStorage.getItem('rg-picks') ?? '{}');
    } catch {}
  const parse = (s?: string) => (s ?? '').split(',').map(x => byId.get(Number(x))).filter((i): i is number => i !== undefined).slice(0, MAX_PICKS);
  like = parse(src.like);
  dislike = parse(src.dislike).filter(i => !like.includes(i));
}

function toggle(list: 'like' | 'dislike', i: number) {
  const [mine, other] = list === 'like' ? [like, dislike] : [dislike, like];
  const at = mine.indexOf(i);
  if (at >= 0) mine.splice(at, 1);
  else {
    mine.push(i);
    if (mine.length > MAX_PICKS) mine.shift();
    const o = other.indexOf(i);
    if (o >= 0) other.splice(o, 1);
  }
  picksChanged();
}

function picksChanged() {
  savePicks();
  renderTray();
  syncLikeButtons();
  if (recResults) runRecommend();
}

function syncLikeButtons() {
  const i = map.selected;
  $('d-like').setAttribute('aria-pressed', String(i !== null && like.includes(i)));
  $('d-like').textContent = i !== null && like.includes(i) ? '♥ Liked' : '♥ Like';
  $('d-dislike').setAttribute('aria-pressed', String(i !== null && dislike.includes(i)));
}

function renderTray() {
  const tray = $('tray');
  tray.hidden = !like.length && !dislike.length;
  const picks = $('picks');
  picks.innerHTML = '';
  for (const [cls, list] of [['l', like], ['d', dislike]] as const)
    for (const i of list) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `pick ${cls}`;
      b.textContent = data.films[i].title;
      b.title = 'Remove';
      b.onclick = () => toggle(cls === 'l' ? 'like' : 'dislike', i);
      picks.append(b);
    }
  const go = $<HTMLButtonElement>('rec-go');
  go.disabled = !like.length || !tags;
  go.textContent = recResults ? 'Done ✕' : 'Recommend 12 →';
  go.classList.toggle('on', recResults !== null);
}

$('d-like').onclick = () => map.selected !== null && toggle('like', map.selected);
$('d-dislike').onclick = () => map.selected !== null && toggle('dislike', map.selected);
$('rec-go').onclick = () => (recResults ? exitRecommend(true) : runRecommend());

function runRecommend() {
  if (!tags || !like.length) {
    exitRecommend(true);
    return;
  }
  recResults = recommend(vecs, like, dislike);
  if (map.selected !== null) {
    map.selected = null;
    map.neighbours = [];
    trail = [];
    $('detail').classList.remove('open');
  }
  map.rec = { like: [...like], dislike: [...dislike], results: recResults };
  map.chat = null;
  panelHead('Recommended for you', 'match');
  const list = $('p-list');
  list.innerHTML = '';
  for (const r of recResults) {
    const why = shared(vecs[r.film], vecs[r.from]).slice(0, 2).map(d => {
      const [key, label] = tags!.vocab[d];
      return key.startsWith('d:') ? `dir. ${label}` : key.startsWith('g:') ? label.toLowerCase() : label;
    });
    list.append(
      simRow(r.film, matchOf(data.scale, r.score), `because you liked <em>${esc(data.films[r.from].title)}</em>${why.length ? ' · ' + esc(why.join(' · ')) : ''}`, () => {}),
    );
  }
  $('panel').classList.add('open');
  setInsets();
  map.fit(true);
  renderTray();
  live(`${recResults.length} recommendations, from ${like.length} liked films.`);
}

function exitRecommend(closePanel: boolean) {
  recResults = null;
  map.rec = null;
  if (closePanel && chatResults && map.selected === null) showChat(false);
  else if (closePanel) $('panel').classList.remove('open');
  setInsets();
  renderTray();
  map.invalidate();
}

// ---------- chat results ----------

let chatResults: ChatResult[] | null = null;
let chatWhys: Record<number, string> = {};
let chatQuestion = '';

/** The right panel as "From chat": number, poster, title, why it fits and where that came from. */
function showChat(fit: boolean) {
  if (!chatResults) return;
  panelHead('From chat', `${chatResults.length} film${chatResults.length === 1 ? '' : 's'}`, `“${chatQuestion}”`);
  const list = $('p-list');
  list.innerHTML = '';
  chatResults.forEach((r, k) => {
    const n = data.films[r.film];
    const why = chatWhys[k + 1];
    const li = document.createElement('li');
    li.innerHTML =
      `<button type="button" class="sim" data-i="${r.film}"><span class="num">${k + 1}</span><img src="${IMG}w92${n.poster}" alt="" loading="lazy">` +
      `<span class="mid"><span class="t"><span class="dot" style="background:${data.kinds[n.kind].color}"></span>` +
      `<span class="nm">${esc(n.title)}</span> <span class="y">${n.year}</span></span>` +
      `<span class="why${why ? '' : ' pending'}">${why ? esc(why) : 'Writing why…'}</span>` +
      `<span class="src">${r.source === 'wikipedia' ? 'from the film’s Wikipedia article' : 'from its tags and similar films'}</span></span></button>`;
    const b = li.firstElementChild as HTMLButtonElement;
    b.onclick = () => openFilm(r.film);
    b.onmouseenter = b.onfocus = () => chatHover(r.film);
    b.onmouseleave = b.onblur = () => chatHover(null);
    list.append(li);
  });
  $('panel').classList.add('open');
  setInsets();
  if (fit) map.fitFilms(chatResults.map(r => r.film));
}

function chatHover(i: number | null) {
  if (!map.chat) return;
  map.chat.hover = i;
  document.querySelectorAll<HTMLElement>('#p-list .sim[data-i]').forEach(el => el.classList.toggle('hot', Number(el.dataset.i) === i));
  map.invalidate();
}

const chat = new Chat(data.films, {
  picks: () => ({ like: like.map(i => data.films[i].id), dislike: dislike.map(i => data.films[i].id) }),
  results(films, question) {
    if (recResults) exitRecommend(false);
    chatResults = films;
    chatWhys = {};
    chatQuestion = question;
    map.chat = { films: films.map(r => r.film), hover: null };
    if (map.selected !== null) {
      map.selected = null;
      map.neighbours = [];
      trail = [];
      $('detail').classList.remove('open');
    }
    if (films.length) showChat(true);
    else $('panel').classList.remove('open');
    setInsets();
    recompute();
    live(films.length ? `${films.length} films from chat: ${films.map(r => data.films[r.film].title).join(', ')}.` : 'No films found.');
  },
  why(n, text) {
    chatWhys[n] = text;
    const el = document.querySelectorAll<HTMLElement>('#p-list .sim[data-i] .why')[n - 1];
    if (el && $('p-title').textContent === 'From chat') {
      el.textContent = text;
      el.classList.remove('pending');
    }
  },
  clear() {
    chatResults = null;
    map.chat = null;
    if ($('p-title').textContent === 'From chat') $('panel').classList.remove('open');
    $('p-back').hidden = true;
    setInsets();
    recompute();
  },
  open: i => openFilm(i),
  hover: chatHover,
});
new ResizeObserver(() => {
  setInsets();
  document.body.classList.toggle('chatting', chat.active);
}).observe($('chat'));
document.body.classList.toggle('chatting', chat.active);

$('p-back').onclick = () => {
  closePanels(); // shows the chat results again and drops ?film= from the URL
  showChat(true);
};

// ---------- keys and zoom buttons ----------

$('z-in').onclick = () => map.zoomBy(1.6);
$('z-out').onclick = () => map.zoomBy(1 / 1.6);
$('z-fit').onclick = () => map.fit(true);
$('d-close').onclick = closePanels;

addEventListener('keydown', e => {
  const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    chat.focus();
    return;
  }
  if (e.key === 'Escape') {
    if (recResults && map.selected === null) exitRecommend(true);
    else back();
    return;
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === '/') {
    e.preventDefault();
    search.focus();
  } else if (e.key === 'l' || e.key === 'L') {
    map.showLabels = !map.showLabels;
    map.invalidate();
  } else if (e.key === '+' || e.key === '=') map.zoomBy(1.6);
  else if (e.key === '-') map.zoomBy(1 / 1.6);
  else if (e.key === 'f') map.fit(true);
});
addEventListener('resize', () => {
  setInsets();
  map.invalidate();
});

// ---------- start ----------

loadPicks();
renderTray();
recompute();
$('loading').classList.add('done');
const startId = Number(new URL(location.href).searchParams.get('film'));
if (byId.has(startId)) openFilm(byId.get(startId)!, { center: true });

// Card details and tag vectors load after first paint.
$('loadnote').textContent = '';
const [d, t] = await Promise.all([loadJson<Detail[]>('detail'), loadJson<Tags>('tags')]);
details = d;
tags = t;
vecs = t.vecs.map(toVec);
filmDims = vecs.map(v => new Set(v.keys()));
renderTray();
if (map.selected !== null) openFilm(map.selected, { push: false, center: false });
if (search.value) showResults();

// A hook for scripts/check.mjs.
Object.assign(window, {
  __rg: {
    count: N,
    get selected() {
      return map.selected === null ? null : data.films[map.selected].id;
    },
    get trail() {
      return trail.map(i => data.films[i].id);
    },
    get highlighted() {
      return map.highlighted ? map.highlighted.reduce((s, v) => s + v, 0) : null;
    },
    get rec() {
      return recResults?.map(r => data.films[r.film].id) ?? null;
    },
    get chat() {
      return map.chat?.films.map(i => data.films[i].id) ?? null;
    },
    screenOf: (id: number) => map.screenOf(byId.get(id)!),
    emptyPoint: () => map.emptyPoint(),
    ready: true,
  },
});
