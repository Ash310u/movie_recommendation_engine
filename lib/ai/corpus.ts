// Loads everything the chat assistant searches, once per server process: the map's films (for
// ids, titles, filters and the tag vectors behind "more like X") and the Wikipedia index built by
// scripts/ai-index.mjs.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { toVec, type Vec } from '../../components/map/recommend';

export interface CFilm {
  i: number;
  id: number;
  title: string;
  year: number;
  lang: string;
  kind: number;
  runtime: number | null;
  /** 0..1 from log votes */
  pop: number;
  /** TMDB genre names and credits, matched in plain code only (never sent to the model) */
  genres: Set<string>;
  people: string[];
}

export interface Chunk { film: number; sec: string; text: string }

export interface Corpus {
  films: CFilm[];
  byId: Map<number, CFilm>;
  vecs: Vec[];
  scale: number[];
  genreNames: string[];
  chunks: Chunk[];
  /** chunk index -> film index */
  chunkFilm: Int32Array;
  emb: Float32Array;
  dim: number;
  wiki: Record<string, { wiki: string; subjects: string[] }>;
  bm25: Bm25;
  embedModel: string;
}

// ---------- BM25 over the passages ----------

const STOP = new Set(
  'a an and are as at be by for from has have he her his i in is it its me movie movies film films of on or she that the their them they this to want watch was were where which who with would like some something about show shown shows into'.split(' '),
);
export const tokens = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(t => t.length > 1 && !STOP.has(t));

export class Bm25 {
  private post = new Map<string, [number, number][]>(); // term -> [doc, tf]
  private len: Float32Array;
  private avg: number;
  constructor(docs: string[]) {
    this.len = new Float32Array(docs.length);
    docs.forEach((d, i) => {
      const tf = new Map<string, number>();
      const ts = tokens(d);
      this.len[i] = ts.length;
      for (const t of ts) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const [t, n] of tf) (this.post.get(t) ?? this.post.set(t, []).get(t)!).push([i, n]);
    });
    this.avg = this.len.reduce((s, x) => s + x, 0) / Math.max(1, docs.length);
  }
  /** Scores for every doc that matches any query term. */
  search(query: string): Map<number, number> {
    const N = this.len.length, k1 = 1.2, b = 0.75;
    const out = new Map<number, number>();
    for (const t of new Set(tokens(query))) {
      const p = this.post.get(t);
      if (!p) continue;
      const idf = Math.log(1 + (N - p.length + 0.5) / (p.length + 0.5));
      for (const [d, tf] of p) {
        const s = (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * this.len[d]) / this.avg));
        out.set(d, (out.get(d) ?? 0) + s);
      }
    }
    return out;
  }
}

// ---------- load ----------

let cached: Corpus | null = null;

export function corpus(): Corpus {
  if (cached) return cached;
  const root = process.cwd();
  const read = (...p: string[]) => JSON.parse(readFileSync(join(root, ...p), 'utf8'));
  const map = read('public', 'data', 'map.json');
  const detail = read('public', 'data', 'detail.json') as { runtime: number | null; chips: [number, string][]; director: string | null; cast: string[] }[];
  const tags = read('public', 'data', 'tags.json') as { vocab: [string, string, number][]; vecs: number[][] };

  const genreDims = new Map<number, string>();
  tags.vocab.forEach(([key, label], d) => key.startsWith('g:') && genreDims.set(d, label));
  const films: CFilm[] = map.films.map((r: [number, number, number, number, number, string, number, string, string, string, number], i: number) => ({
    i,
    id: r[0],
    kind: r[1],
    title: r[5],
    year: r[6],
    lang: r[9],
    runtime: detail[i].runtime,
    pop: r[4],
    people: [...(detail[i].director ?? '').split(' & '), ...detail[i].cast].filter(Boolean).map(n => n.toLowerCase()),
    genres: new Set(detail[i].chips.filter(([d]) => genreDims.has(d)).map(([d]) => genreDims.get(d)!)),
  }));
  const byId = new Map(films.map(f => [f.id, f]));

  const aiDir = join(root, 'data', 'ai');
  let chunks: Chunk[] = [], emb = new Float32Array(0), dim = 0, wiki = {}, embedModel = '';
  if (existsSync(join(aiDir, 'meta.json'))) {
    const meta = read('data', 'ai', 'meta.json');
    chunks = read('data', 'ai', 'chunks.json');
    wiki = read('data', 'ai', 'films.json');
    const buf = readFileSync(join(aiDir, 'vectors.f32'));
    emb = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    dim = meta.dim;
    embedModel = meta.model;
  }
  // Passages of films that left the map since the index was built are skipped.
  const chunkFilm = Int32Array.from(chunks, c => byId.get(c.film)?.i ?? -1);
  cached = {
    films,
    byId,
    vecs: tags.vecs.map(toVec),
    scale: map.scale,
    genreNames: [...new Set(genreDims.values())].sort(),
    chunks,
    chunkFilm,
    emb,
    dim,
    wiki,
    bm25: new Bm25(chunks.map((c, i) => (chunkFilm[i] >= 0 ? c.text : ''))),
    embedModel,
  };
  return cached;
}

/** Matches a title the model or visitor wrote to a film on the map. */
export function findFilm(c: Corpus, title: string, year?: number | null): CFilm | null {
  const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const t = norm(title);
  if (!t) return null;
  const exact = c.films.filter(f => norm(f.title) === t);
  if (exact.length) return exact.find(f => year && Math.abs(f.year - year) <= 1) ?? exact.sort((a, b) => b.year - a.year)[0];
  const loose = c.films.filter(f => norm(f.title).startsWith(t) || t.startsWith(norm(f.title)));
  return loose.length === 1 ? loose[0] : (loose.find(f => year && Math.abs(f.year - year) <= 1) ?? null);
}
