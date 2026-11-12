// Step 2 and 3 of plans/chat-discovery.md: three searches (meaning, keywords, taste), merged with
// reciprocal rank fusion, hard filters in plain code, then MMR for variety.
import { dot, recommend } from '../../components/map/recommend';
import type { Corpus, CFilm } from './corpus';
import type { Query } from './understand';

export interface Hit {
  film: CFilm;
  score: number;
  /** best-matching Wikipedia passage, if any */
  passage: string | null;
  /** which searches found it */
  via: ('meaning' | 'keywords' | 'taste' | 'named')[];
}

const TOP = 60;

/**
 * Similarity per film for a query embedding: its best passage, plus a little of its second best,
 * so a film that matches throughout beats one with a single lucky passage.
 */
function semantic(c: Corpus, q: Float32Array) {
  const top = new Map<number, { a: number; b: number; chunk: number }>();
  const { emb, dim, chunkFilm } = c;
  for (let k = 0; k < chunkFilm.length; k++) {
    const f = chunkFilm[k];
    if (f < 0) continue;
    let s = 0;
    const o = k * dim;
    for (let d = 0; d < dim; d++) s += q[d] * emb[o + d];
    const cur = top.get(f);
    if (!cur) top.set(f, { a: s, b: s, chunk: k });
    else if (s > cur.a) (cur.b = cur.a), (cur.a = s), (cur.chunk = k);
    else if (s > cur.b || cur.b === cur.a) cur.b = s;
  }
  const best = new Map<number, { s: number; chunk: number }>();
  for (const [f, t] of top) best.set(f, { s: 0.75 * t.a + 0.25 * t.b, chunk: t.chunk });
  return best;
}

function keyword(c: Corpus, keywords: string[]): { best: Map<number, { s: number; chunk: number }>; credited: number[] } {
  const text = keywords.join(' ');
  const scores = c.bm25.search(text);
  const best = new Map<number, { s: number; chunk: number }>();
  for (const [k, s] of scores) {
    const f = c.chunkFilm[k];
    if (f < 0) continue;
    const cur = best.get(f);
    if (!cur || s > cur.s) best.set(f, { s, chunk: k });
  }
  // A keyword naming a film's director or a lead actor ("Hitchcock", "Tom Hanks") finds it.
  const names = keywords.map(k => k.toLowerCase().trim()).filter(k => k.length > 2);
  const credited = c.films
    .filter(film => names.some(k => film.people.some(p => p === k || p.endsWith(` ${k}`) || p.startsWith(`${k} `))))
    .sort((a, b) => b.pop - a.pop)
    .map(f => f.i);
  // A keyword that is a film's whole title finds that film.
  const words = text.toLowerCase();
  for (const film of c.films) {
    const t = film.title.toLowerCase();
    if (t.length > 3 && new RegExp(`(^|\\W)${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\W|$)`).test(words)) best.set(film.i, { s: 1e3, chunk: best.get(film.i)?.chunk ?? -1 });
  }
  return { best, credited };
}

const ranked = (m: Map<number, { s: number }>, ok: (f: number) => boolean) =>
  [...m]
    .filter(([f]) => ok(f))
    .sort((a, b) => b[1].s - a[1].s || a[0] - b[0])
    .slice(0, TOP)
    .map(([f]) => f);

export function passes(f: CFilm, q: Query) {
  const { filters: fl, exclude: ex } = q;
  if (fl.yearFrom && f.year < fl.yearFrom) return false;
  if (fl.yearTo && f.year > fl.yearTo) return false;
  if (fl.languages.length && !fl.languages.includes(f.lang)) return false;
  if (fl.maxRuntime && f.runtime && f.runtime > fl.maxRuntime) return false;
  if (fl.genres.length && !fl.genres.every(g => f.genres.has(g))) return false;
  if (ex.genres.some(g => f.genres.has(g))) return false;
  return true;
}

export interface SearchInput {
  query: Query;
  /** embedding of query.about (null when there is none or the model is offline) */
  aboutVec: Float32Array | null;
  excludeVec: Float32Array | null;
  like: number[]; // film indices
  dislike: number[];
}

export function search(c: Corpus, { query, aboutVec, excludeVec, like, dislike }: SearchInput): { hits: Hit[]; filteredOut: number } {
  const lists: { name: Hit['via'][number]; order: number[]; w?: number }[] = [];
  const passageOf = new Map<number, number>();
  // Filters apply before ranking, so a strict request still gets a full list.
  let filteredOut = 0;
  const allowed = new Uint8Array(c.films.length);
  c.films.forEach(f => (allowed[f.i] = passes(f, query) ? 1 : 0));
  const ok = (f: number) => allowed[f] === 1;
  let namedPerson = false;

  let sem: Map<number, { s: number; chunk: number }> | null = null;
  if (aboutVec && c.dim) {
    sem = semantic(c, aboutVec);
    if (excludeVec) {
      const neg = semantic(c, excludeVec);
      for (const [f, v] of sem) v.s -= 0.5 * (neg.get(f)?.s ?? 0);
    }
    const order = ranked(sem, ok);
    filteredOut += ranked(sem, () => true).filter(f => !ok(f)).length;
    order.forEach(f => passageOf.set(f, sem!.get(f)!.chunk));
    lists.push({ name: 'meaning', order });
  }
  // Keywords are the specific names and rare words the model picked out, not the description.
  if (query.keywords.some(k => k.trim())) {
    const { best: kw, credited } = keyword(c, query.keywords);
    const order = ranked(kw, ok);
    order.forEach(f => !passageOf.has(f) && kw.get(f)!.chunk >= 0 && passageOf.set(f, kw.get(f)!.chunk));
    lists.push({ name: 'keywords', order });
    // A named director or actor is the strongest signal in a request: their films, best known first.
    if (credited.some(ok)) {
      namedPerson = true;
      lists.push({ name: 'named', order: credited.filter(ok).slice(0, TOP), w: 4 });
    }
  }
  if (like.length) {
    const recs = recommend(c.vecs, like, dislike, TOP);
    lists.push({ name: 'taste', order: recs.map(r => r.film).filter(ok) });
  }
  // Only filters ("Japanese films", "90s comedies"): the best-known films that pass them.
  if (!lists.length) lists.push({ name: 'keywords', order: c.films.filter(f => ok(f.i)).sort((a, b) => b.pop - a.pop).slice(0, TOP).map(f => f.i) });

  // Reciprocal rank fusion.
  const fused = new Map<number, { s: number; via: Set<Hit['via'][number]> }>();
  for (const { name, order, w = 1 } of lists) {
    order.forEach((f, r) => {
      const e = fused.get(f) ?? fused.set(f, { s: 0, via: new Set() }).get(f)!;
      e.s += w / (60 + r);
      e.via.add(name);
    });
  }
  const exclude = new Set([...like, ...dislike]);
  const cands = [...fused]
    .filter(([f]) => !exclude.has(f) && ok(f))
    .sort((a, b) => b[1].s - a[1].s || a[0] - b[0])
    .slice(0, 40);

  // MMR over the tag vectors, so results aren't near-copies of each other. Not when a person is
  // named: "Hitchcock" asks for films that are alike.
  const variety = namedPerson ? 0.05 : 0.25;
  const out: typeof cands = [];
  const maxS = cands[0]?.[1].s || 1;
  while (out.length < query.count && cands.length) {
    let best = 0, bestScore = -Infinity;
    cands.forEach(([f, e], n) => {
      const red = out.reduce((m, [o]) => Math.max(m, dot(c.vecs[f], c.vecs[o])), 0);
      const mmr = (1 - variety) * (e.s / maxS) - variety * red;
      if (mmr > bestScore) (bestScore = mmr), (best = n);
    });
    out.push(cands.splice(best, 1)[0]);
  }

  // A film's best passage for the answer: from the meaning search if it has one.
  const bestPassage = (f: number) => {
    let k = passageOf.get(f);
    if (k === undefined && sem?.has(f)) k = sem.get(f)!.chunk;
    if (k === undefined) k = c.chunkFilm.findIndex(x => x === f);
    return k >= 0 ? c.chunks[k].text : null;
  };
  return {
    hits: out.map(([f, e]) => ({ film: c.films[f], score: e.s, passage: bestPassage(f), via: [...e.via] })),
    filteredOut,
  };
}

/** The passage that best describes a film, for questions about one film. */
export function filmPassages(c: Corpus, film: number, n = 3) {
  const out: string[] = [];
  c.chunkFilm.forEach((f, k) => f === film && out.length < n && out.push(c.chunks[k].text));
  return out;
}
