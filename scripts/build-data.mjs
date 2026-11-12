// Builds the static data for the map (no database yet, see plans/vector-map-ui.md):
//   public/data/map.json     kinds, sub-clusters, languages, films as compact rows, cross-kind edges
//   public/data/detail.json  per-film card data and the 8 nearest films with match % and reasons
//   public/data/tags.json    tag vocabulary and each film's TF-IDF vector (highlighting, recommend)
//
//   npm run data        (TMDB_TOKEN or .tmdb-token; TMDB_DNS=1.1.1.1 if DNS blocks TMDB)
//   PER_KIND=190 PER_LANG=60
//
// Ported from mov/scripts/fetch-orbit.mjs. Similarity is plain arithmetic over shared tags
// (keywords, genres, director, cast, decade): TMDB's terms rule out running its data through
// ML models, so there are no embeddings and no UMAP. Responses are cached in .cache/tmdb/, so a
// second run is offline and gives the same files.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KINDS, kindFor, kindVector } from '../lib/kinds.ts';
import { tmdbClient } from '../lib/tmdb/client.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public', 'data');
const pins = JSON.parse(readFileSync(join(root, 'scripts', 'pins.json'), 'utf8'));

const PER_KIND = Number(process.env.PER_KIND) || 190;
const PER_LANG = Number(process.env.PER_LANG) || 60;
const LANGS = ['fr', 'ja', 'ko', 'es', 'it', 'de', 'hi', 'zh'];
const PAGES = 8; // discover pages per kind, 20 films each
const MAX_PAGES = 150; // more for kinds that lose films to higher-priority ones
const MIN_VOTES = 400;
const FALLBACK_VOTES = 150;
const NEIGHBOURS = 8;

let fetched = 0;
const tmdbApi = tmdbClient({ root, onFetch: () => ++fetched % 200 === 0 && console.log(`  ${fetched} requests…`) });
const tmdb = (path, params) =>
  tmdbApi.get(path, params).catch(e => {
    console.error(e.message);
    process.exit(1);
  });

const discover = (extra, page) =>
  tmdb('/discover/movie', {
    without_genres: '99|10770',
    sort_by: 'vote_count.desc',
    include_adult: 'false',
    language: 'en-US',
    page,
    ...extra,
  });

// Bayesian rating, so a film with few votes can't top a kind. C is fixed so ranking from the
// discover lists (before details) and from details agree.
const C = 6.8, M = 3000;
const score = (avg, votes) => (votes / (votes + M)) * avg + (M / (votes + M)) * C;

// ---------- 1. candidates ----------

console.log('Finding candidates…');
const seen = new Map(); // id -> discover row
const byKind = new Map(KINDS.map(k => [k.id, []]));
await Promise.all(
  KINDS.map(async k => {
    const own = byKind.get(k.id);
    // Kinds that run out at MIN_VOTES (pure Action loses most films to other kinds) try again
    // with a lower floor.
    for (const votes of [MIN_VOTES, FALLBACK_VOTES]) {
      if (own.length >= PER_KIND * 1.4) break;
      for (let page = 1; page <= MAX_PAGES && (page <= PAGES || own.length < PER_KIND * 1.4); page++) {
        const r = await discover({ with_genres: k.genres.join('|'), 'vote_count.gte': votes }, page);
        for (const f of r.results) {
          seen.set(f.id, f);
          if (kindFor(f.genre_ids) === k.id && !own.includes(f.id)) own.push(f.id);
        }
        if (page >= r.total_pages) break;
      }
    }
  }),
);
// Each kind: its best films by the discover data, with headroom for films whose details fail.
const wantIds = new Set();
for (const own of byKind.values())
  own
    .map(id => seen.get(id))
    .sort((a, b) => score(b.vote_average, b.vote_count) - score(a.vote_average, a.vote_count) || a.id - b.id)
    .slice(0, Math.ceil(PER_KIND * 1.2))
    .forEach(f => wantIds.add(f.id));

// Non-English passes, so the language filter means something.
const langPool = new Map();
await Promise.all(
  LANGS.map(async lang => {
    const pool = [];
    for (let page = 1; page <= 6; page++) {
      const r = await discover({ with_original_language: lang, 'vote_count.gte': 150 }, page);
      for (const f of r.results) if (kindFor(f.genre_ids)) pool.push(f);
      if (page >= r.total_pages) break;
    }
    pool.sort((a, b) => score(b.vote_average, b.vote_count) - score(a.vote_average, a.vote_count) || a.id - b.id);
    langPool.set(lang, pool);
    for (const f of pool.slice(0, PER_LANG * 2)) wantIds.add(f.id);
  }),
);

const pinned = new Set();
for (const w of pins.include ?? []) {
  const r = await tmdb('/search/movie', { query: w.title, include_adult: 'false', language: 'en-US', ...(w.year ? { year: w.year } : {}) });
  const hit = r.results[0];
  if (!hit) console.warn(`  pin not found: ${w.title} (${w.year ?? '?'})`);
  else {
    pinned.add(hit.id);
    wantIds.add(hit.id);
  }
}

// ---------- 2. details ----------

console.log(`Fetching details for ${wantIds.size} films…`);
const ids = [...wantIds].sort((a, b) => a - b);
const details = await Promise.all(ids.map(id => tmdb(`/movie/${id}`, { append_to_response: 'keywords,credits,external_ids', language: 'en-US' })));

// ---------- 3. kinds, ranking and the chosen films ----------

const overrides = pins.overrides ?? {};
const all = details
  .filter(d => d.poster_path && d.overview && d.release_date && d.vote_count >= 100)
  .map(d => ({ d, kind: overrides[d.id] ?? kindFor(d.genres.map(g => g.id)) }))
  .filter(x => x.kind);
const rank = (a, b) => score(b.d.vote_average, b.d.vote_count) - score(a.d.vote_average, a.d.vote_count) || a.d.id - b.d.id;

const chosen = [];
const taken = new Set();
const take = x => {
  if (taken.has(x.d.id)) return;
  taken.add(x.d.id);
  chosen.push(x);
};
for (const k of KINDS) {
  const inKind = all.filter(x => x.kind === k.id && x.d.vote_count >= FALLBACK_VOTES).sort(rank);
  inKind.filter(x => pinned.has(x.d.id)).forEach(take);
  let n = inKind.filter(x => pinned.has(x.d.id)).length;
  for (const x of inKind) if (n < PER_KIND && !taken.has(x.d.id)) (take(x), n++);
  if (n < PER_KIND * 0.8) console.warn(`  ${k.name}: only ${n} films`);
}
for (const lang of LANGS) {
  let n = chosen.filter(x => x.d.original_language === lang).length;
  for (const x of all.filter(x => x.d.original_language === lang).sort(rank)) if (n < PER_LANG && !taken.has(x.d.id)) (take(x), n++);
}
for (const x of all) if (pinned.has(x.d.id)) take(x);
const N = chosen.length;

// ---------- 4. tags and TF-IDF vectors ----------

const label = new Map();
const tagsOf = d => {
  const tags = new Map();
  const add = (key, w, text) => {
    tags.set(key, Math.max(tags.get(key) ?? 0, w));
    label.set(key, text);
  };
  const kw = d.keywords?.keywords ?? d.keywords?.results ?? [];
  for (const k of kw) add(`k:${k.id}`, 1, k.name);
  for (const g of d.genres) add(`g:${g.id}`, 0.4, g.name);
  for (const c of d.credits?.crew ?? []) if (c.job === 'Director') add(`d:${c.id}`, 1.5, c.name);
  for (const c of d.credits?.cast ?? []) if (c.order < 5) add(`c:${c.id}`, 0.6, c.name);
  const decade = Math.floor(Number(d.release_date.slice(0, 4)) / 10) * 10;
  add(`y:${decade}`, 0.3, `${decade}s`);
  return tags;
};
const rawTags = chosen.map(x => tagsOf(x.d));
const df = new Map();
for (const t of rawTags) for (const k of t.keys()) df.set(k, (df.get(k) ?? 0) + 1);

// Dimensions: every tag with df >= 2, in a stable order.
const vocab = [...df.keys()].filter(k => df.get(k) >= 2).sort();
const dimOf = new Map(vocab.map((k, i) => [k, i]));
const vecs = rawTags.map(t => {
  const v = [];
  for (const [k, w] of t) if (dimOf.has(k)) v.push([dimOf.get(k), w * Math.log(N / df.get(k))]);
  const norm = Math.hypot(...v.map(p => p[1])) || 1;
  return v.map(([d, w]) => [d, w / norm]).sort((a, b) => a[0] - b[0]);
});

// ---------- 5. nearest films (inverted index, exact cosine) ----------

console.log(`Scoring ${N} films…`);
const postings = vocab.map(() => []);
vecs.forEach((v, i) => v.forEach(([d, w]) => postings[d].push(i, w)));
const kindIdx = chosen.map(x => KINDS.findIndex(k => k.id === x.kind));
const acc = new Float64Array(N);
const neighbours = vecs.map((v, i) => {
  acc.fill(0);
  for (const [d, w] of v) {
    const p = postings[d];
    for (let q = 0; q < p.length; q += 2) acc[p[q]] += w * p[q + 1];
  }
  acc[i] = -1;
  const top = [];
  for (let j = 0; j < N; j++) {
    const s = acc[j];
    if (s <= 0 || (top.length === NEIGHBOURS && s <= top[NEIGHBOURS - 1].sim)) continue;
    top.push({ j, sim: s });
    top.sort((a, b) => b.sim - a.sim || a.j - b.j);
    if (top.length > NEIGHBOURS) top.pop();
  }
  return top;
});

const vecMap = vecs.map(v => new Map(v));
const reasonsOf = (i, j) => {
  const parts = [];
  for (const [d, w] of vecs[i]) if (vecMap[j].has(d)) parts.push([d, w * vecMap[j].get(d)]);
  return parts
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([d]) => {
      const k = vocab[d];
      return k.startsWith('d:') ? `dir. ${label.get(k)}` : k.startsWith('g:') ? label.get(k).toLowerCase() : label.get(k);
    });
};

// "Match": the percentile of the score among all kept neighbour scores, spread over 55–99%.
const kept = neighbours.flat().map(n => n.sim).sort((a, b) => a - b);
const percentile = s => {
  let lo = 0, hi = kept.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (kept[mid] < s) lo = mid + 1;
    else hi = mid;
  }
  return lo / Math.max(1, kept.length - 1);
};
const matchOf = s => Math.min(99, Math.max(55, Math.round(55 + 44 * percentile(s))));

// ---------- 6. sub-clusters: seeded label propagation on the neighbour graph ----------

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Undirected within-kind edges, weighted by score.
const adj = chosen.map(() => new Map());
neighbours.forEach((ns, i) =>
  ns.forEach(({ j, sim }) => {
    if (kindIdx[i] !== kindIdx[j]) return;
    adj[i].set(j, Math.max(adj[i].get(j) ?? 0, sim));
    adj[j].set(i, Math.max(adj[j].get(i) ?? 0, sim));
  }),
);

const MIN_SUB = 8, MAX_SUBS = 7;
const sub = new Int32Array(N).fill(-1);
const subs = []; // {kind, members[], name, cx, cy}
for (let k = 0; k < KINDS.length; k++) {
  const members = chosen.map((_, i) => i).filter(i => kindIdx[i] === k);
  const rand = mulberry32(11 + k);
  const lab = new Map(members.map(i => [i, i]));
  for (let round = 0; round < 30; round++) {
    const order = [...members];
    for (let a = order.length - 1; a > 0; a--) {
      const b = Math.floor(rand() * (a + 1));
      [order[a], order[b]] = [order[b], order[a]];
    }
    let changed = 0;
    for (const i of order) {
      const votes = new Map();
      for (const [j, w] of adj[i]) votes.set(lab.get(j), (votes.get(lab.get(j)) ?? 0) + w);
      let best = lab.get(i), bw = -1;
      for (const [l, w] of votes) if (w > bw || (w === bw && l < best)) (best = l), (bw = w);
      if (best !== lab.get(i)) (lab.set(i, best), changed++);
    }
    if (!changed) break;
  }
  // Merge communities that are too small (or too many) into their best-connected neighbour.
  const groups = () => {
    const g = new Map();
    for (const i of members) (g.get(lab.get(i)) ?? g.set(lab.get(i), []).get(lab.get(i))).push(i);
    return [...g.values()].sort((a, b) => a.length - b.length || a[0] - b[0]);
  };
  for (let gs = groups(); gs.length > 1 && (gs[0].length < MIN_SUB || gs.length > MAX_SUBS); gs = groups()) {
    const small = gs[0], from = lab.get(small[0]);
    const links = new Map();
    for (const i of small) for (const [j, w] of adj[i]) if (lab.get(j) !== from) links.set(lab.get(j), (links.get(lab.get(j)) ?? 0) + w);
    let to = lab.get(gs[gs.length - 1][0]), bw = 0;
    for (const [l, w] of links) if (w > bw) (to = l), (bw = w);
    for (const i of small) lab.set(i, to);
  }
  for (const g of groups().reverse()) {
    const s = subs.length;
    subs.push({ kind: k, members: g });
    for (const i of g) sub[i] = s;
  }
}

// Names: the most distinctive keywords (and directors with 3+ films) of a sub against its kind.
const GENERIC = new Set([
  'based on novel or book', 'aftercreditsstinger', 'duringcreditsstinger', 'woman director', 'sequel', 'remake',
  'based on true story', 'based on play or musical', 'biography', 'individual', 'affectation', 'drama', 'love',
  'friendship', 'husband wife relationship', 'father son relationship', 'mother daughter relationship', 'murder',
  'death', 'new york city', 'los angeles, california', 'london, england', 'paris, france', 'duringcreditsstinger',
  'loss of loved one', 'empathetic', 'admiring', 'romantic', 'comforting', 'sentimental', 'suspenseful', 'intense',
]);
const UPPER = { lgbt: 'LGBT', '3d': '3D', ii: 'II', i: 'I', cia: 'CIA', fbi: 'FBI', ai: 'AI', usa: 'USA' };
const titleCase = s => s.split(' ').map(w => UPPER[w] ?? (w[0]?.toUpperCase() ?? '') + w.slice(1)).join(' ');
const shortLabel = key => {
  const l = label.get(key);
  if (key.startsWith('d:')) return l.split(' ').slice(1).join(' ') || l;
  return titleCase(l);
};
const usedNames = new Set();
for (const s of subs) {
  const kindMembers = chosen.map((_, i) => i).filter(i => kindIdx[i] === s.kind);
  const count = list => {
    const c = new Map();
    for (const i of list) for (const k of rawTags[i].keys()) c.set(k, (c.get(k) ?? 0) + 1);
    return c;
  };
  const inSub = count(s.members), inKind = count(kindMembers);
  const cands = [...inSub]
    .filter(([k, n]) => (k[0] === 'k' ? n >= 2 && !GENERIC.has(label.get(k)) && label.get(k).length <= 20 : k[0] === 'd' && n >= 3))
    .map(([k, n]) => {
      const fs = n / s.members.length, fk = inKind.get(k) / kindMembers.length;
      return [k, fs * Math.log(fs / fk + 1e-9) * Math.sqrt(n) * (k[0] === 'd' ? 1.2 : 1)];
    })
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const parts = [];
  const overlaps = (a, b) => a.toLowerCase().includes(b.toLowerCase()) || b.toLowerCase().includes(a.toLowerCase());
  for (const [k] of cands) {
    if (parts.length === 2) break;
    const l = shortLabel(k);
    if (!parts.some(p => overlaps(p, l))) parts.push(l);
  }
  let name = parts.join(' · ') || KINDS[s.kind].name;
  for (let n = 2; usedNames.has(name); n++) name = `${parts[0] ?? KINDS[s.kind].name} ${n}`;
  usedNames.add(name);
  s.name = name;
}

// ---------- 7. layout ----------

// Inside each kind: subs seeded around the disc, then a force layout with springs along
// within-kind neighbour edges, a pull to the film's sub centroid and k/d² repulsion.
const rand = mulberry32(7);
const local = chosen.map(() => [0, 0]);
for (let k = 0; k < KINDS.length; k++) {
  const ks = subs.filter(s => s.kind === k);
  const members = ks.flatMap(s => s.members);
  ks.forEach((s, si) => {
    const a = (si / ks.length) * Math.PI * 2 + rand(), r = ks.length === 1 ? 0 : 0.55;
    for (const i of s.members) {
      const ja = rand() * Math.PI * 2, jr = Math.sqrt(rand()) * 0.3;
      local[i] = [Math.cos(a) * r + Math.cos(ja) * jr, Math.sin(a) * r + Math.sin(ja) * jr];
    }
  });
  const edges = members.flatMap(i => [...adj[i]].filter(([j]) => j > i).map(([j, w]) => [i, j, w]));
  for (let it = 0; it < 300; it++) {
    const step = 0.02 * (1 - it / 300) + 0.002;
    const force = new Map(members.map(i => [i, [0, 0]]));
    for (let a = 0; a < members.length; a++)
      for (let b = a + 1; b < members.length; b++) {
        const i = members[a], j = members[b];
        let dx = local[i][0] - local[j][0], dy = local[i][1] - local[j][1];
        const d2 = Math.max(dx * dx + dy * dy, 1e-4), f = 0.0018 / d2, d = Math.sqrt(d2);
        dx /= d;
        dy /= d;
        force.get(i)[0] += dx * f; force.get(i)[1] += dy * f;
        force.get(j)[0] -= dx * f; force.get(j)[1] -= dy * f;
      }
    for (const [i, j, sim] of edges) {
      const dx = local[j][0] - local[i][0], dy = local[j][1] - local[i][1];
      const d = Math.hypot(dx, dy) || 1e-3, f = (d - 0.12) * (0.5 + sim) * (sub[i] === sub[j] ? 0.5 : 0.15);
      force.get(i)[0] += (dx / d) * f; force.get(i)[1] += (dy / d) * f;
      force.get(j)[0] -= (dx / d) * f; force.get(j)[1] -= (dy / d) * f;
    }
    for (const s of ks) {
      const cx = s.members.reduce((t, i) => t + local[i][0], 0) / s.members.length;
      const cy = s.members.reduce((t, i) => t + local[i][1], 0) / s.members.length;
      for (const i of s.members) {
        force.get(i)[0] += (cx - local[i][0]) * 0.35;
        force.get(i)[1] += (cy - local[i][1]) * 0.35;
      }
    }
    for (const i of members) {
      const [fx, fy] = force.get(i);
      const gx = fx - local[i][0] * 0.15, gy = fy - local[i][1] * 0.15;
      const len = Math.hypot(gx, gy), cap = Math.min(len, 0.08) / (len || 1);
      local[i][0] += gx * cap * step * 20;
      local[i][1] += gy * cap * step * 20;
    }
  }
  const cx = members.reduce((t, i) => t + local[i][0], 0) / members.length;
  const cy = members.reduce((t, i) => t + local[i][1], 0) / members.length;
  const dists = members.map(i => Math.hypot(local[i][0] - cx, local[i][1] - cy)).sort((a, b) => a - b);
  const r = dists[Math.floor(dists.length * 0.97)] || 1; // a few outliers may sit outside the disc
  for (const i of members) local[i] = [(local[i][0] - cx) / r, (local[i][1] - cy) / r];
}

// Kind centres on a ring in ring order; radius grows with sqrt(count).
const counts = KINDS.map((_, k) => kindIdx.filter(x => x === k).length);
const maxCount = Math.max(...counts);
const centres = KINDS.map((k, i) => {
  const a = -Math.PI / 2 + ((k.ring - 1) / KINDS.length) * Math.PI * 2;
  return { x: Math.cos(a), y: Math.sin(a), r: 0.25 * Math.sqrt(counts[i] / maxCount) };
});

// Hybrids: a film with several neighbours in another kind its genres touch is pulled a little
// toward that kind's centre, so it sits on the border.
const second = chosen.map((x, i) => {
  const kv = kindVector(x.d.genres.map(g => g.id), x.kind);
  const across = new Map();
  for (const { j } of neighbours[i]) if (kindIdx[j] !== kindIdx[i]) across.set(kindIdx[j], (across.get(kindIdx[j]) ?? 0) + 1);
  let best = -1, bn = 0;
  for (const [k, n] of across) if (kv[k] > 0 && (n > bn || (n === bn && k < best))) (best = k), (bn = n);
  return { k: best, strength: Math.min(1, bn / 4) };
});
const pos = chosen.map((_, i) => {
  const c = centres[kindIdx[i]];
  let x = c.x + local[i][0] * c.r, y = c.y + local[i][1] * c.r;
  const s = second[i];
  if (s.k >= 0) {
    const o = centres[s.k], t = 0.25 * s.strength;
    x += (o.x - c.x) * t;
    y += (o.y - c.y) * t;
  }
  return [x, y];
});
// Fit the map into [-1, 1]².
const ext = Math.max(...pos.map(([x, y]) => Math.max(Math.abs(x), Math.abs(y))));
for (const p of pos) (p[0] /= ext), (p[1] /= ext);
for (const c of centres) (c.x /= ext), (c.y /= ext), (c.r /= ext);
for (const s of subs) {
  s.cx = s.members.reduce((t, i) => t + pos[i][0], 0) / s.members.length;
  s.cy = s.members.reduce((t, i) => t + pos[i][1], 0) / s.members.length;
}

// ---------- 8. per-film colour (OKLab mix with the second kind, lightness per sub) ----------

const toLin = c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = c => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const hexToOklab = hex => {
  const [r, g, b] = [1, 3, 5].map(i => toLin(parseInt(hex.slice(i, i + 2), 16) / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
};
const oklabToHex = ([L, A, B]) => {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const rgb = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  return '#' + rgb.map(c => Math.round(Math.min(1, Math.max(0, toSrgb(c))) * 255).toString(16).padStart(2, '0')).join('');
};
const kindLab = KINDS.map(k => hexToOklab(k.color));
const subRank = subs.map(s => subs.filter(t => t.kind === s.kind).indexOf(s));
const colors = chosen.map((_, i) => {
  const base = kindLab[kindIdx[i]], s = second[i];
  let lab = base;
  if (s.k >= 0) {
    const t = 0.35 * s.strength, o = kindLab[s.k];
    lab = base.map((v, q) => v + (o[q] - v) * t);
  }
  const r = subRank[sub[i]];
  const dl = r === 0 ? 0 : (r % 2 ? 1 : -1) * 0.04 * Math.ceil(r / 2);
  return oklabToHex([Math.min(0.95, Math.max(0.45, lab[0] + dl)), lab[1], lab[2]]);
});

// ---------- 9. write ----------

const logVotes = chosen.map(x => Math.log(x.d.vote_count));
const lvMin = Math.min(...logVotes), lvMax = Math.max(...logVotes);
const trim = (s, n) => (s.length <= n ? s : s.slice(0, s.lastIndexOf(' ', n - 1)).replace(/[,.;:]$/, '') + '…');
const round = (v, p = 4) => Math.round(v * 10 ** p) / 10 ** p;
const langCounts = new Map();
for (const x of chosen) langCounts.set(x.d.original_language, (langCounts.get(x.d.original_language) ?? 0) + 1);

// The strongest cross-kind neighbour links, drawn as faint threads.
const cross = [];
neighbours.forEach((ns, i) =>
  ns.forEach(({ j, sim }) => {
    if (kindIdx[i] !== kindIdx[j] && (i < j || !neighbours[j].some(n => n.j === i))) cross.push([i, j, sim]);
  }),
);
cross.sort((a, b) => b[2] - a[2] || a[0] - b[0]);

const map = {
  builtAt: new Date().toISOString(),
  n: N,
  kinds: KINDS.map((k, i) => ({ id: k.id, name: k.name, color: k.color, cx: round(centres[i].x), cy: round(centres[i].y), r: round(centres[i].r), count: counts[i] })),
  subs: subs.map(s => ({ kind: s.kind, name: s.name, cx: round(s.cx), cy: round(s.cy), size: s.members.length })),
  languages: [...langCounts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([code, count]) => ({ code, count })),
  // [id, kind, x, y, pop, title, year, poster, color, language, sub]
  films: chosen.map((x, i) => [
    x.d.id,
    kindIdx[i],
    round(pos[i][0]),
    round(pos[i][1]),
    round((logVotes[i] - lvMin) / (lvMax - lvMin || 1), 2),
    x.d.title,
    Number(x.d.release_date.slice(0, 4)),
    x.d.poster_path,
    colors[i],
    x.d.original_language,
    sub[i],
  ]),
  edges: cross.slice(0, 300).map(([i, j, sim]) => [i, j, matchOf(sim)]),
  // 101 quantiles of the kept neighbour scores, so the app turns any cosine into the same match %.
  scale: Array.from({ length: 101 }, (_, q) => round(kept[Math.min(kept.length - 1, Math.round((q / 100) * (kept.length - 1)))], 5)),
};

const detail = chosen.map((x, i) => {
  const d = x.d;
  const chips = [
    ...d.genres.map(g => `g:${g.id}`),
    ...(d.keywords?.keywords ?? d.keywords?.results ?? []).map(k => `k:${k.id}`).filter(k => dimOf.has(k)).sort((a, b) => df.get(b) - df.get(a)).slice(0, 6),
  ];
  return {
    imdb: d.imdb_id || d.external_ids?.imdb_id || null,
    runtime: d.runtime || null,
    rating: Math.round(d.vote_average * 10) / 10,
    votes: d.vote_count,
    director: (d.credits?.crew ?? []).filter(c => c.job === 'Director').map(c => c.name).slice(0, 2).join(' & ') || null,
    cast: (d.credits?.cast ?? []).slice(0, 4).map(c => c.name),
    overview: trim(d.overview, 320),
    chips: chips.map(k => [dimOf.get(k) ?? -1, label.get(k)]),
    nb: neighbours[i].map(n => [n.j, matchOf(n.sim), reasonsOf(i, n.j)]),
  };
});

const tags = {
  // [key, label, df]
  vocab: vocab.map(k => [k, label.get(k), df.get(k)]),
  // per film: flat [dim, weight, dim, weight, …]
  vecs: vecs.map(v => v.flatMap(([d, w]) => [d, round(w, 3)])),
};

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'map.json'), JSON.stringify(map));
writeFileSync(join(outDir, 'detail.json'), JSON.stringify(detail));
writeFileSync(join(outDir, 'tags.json'), JSON.stringify(tags));
console.log(`${N} films, ${subs.length} sub-clusters, ${vocab.length} tags → public/data/`);
console.log('  ' + KINDS.map((k, i) => `${k.name} ${counts[i]}`).join(', '));
console.log('  ' + map.languages.slice(0, 10).map(l => `${l.code} ${l.count}`).join(', '));
