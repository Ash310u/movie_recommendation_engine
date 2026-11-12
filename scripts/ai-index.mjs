// Builds the chat assistant's search index from Wikipedia and Wikidata (plans/chat-discovery.md 2.5):
//   data/ai/chunks.json   [{ film, sec, text }] — film is the TMDB id, text a ~220-word passage
//   data/ai/films.json    { [tmdbId]: { wiki, subjects } } — article title and Wikidata subjects
//   data/ai/vectors.f32   one L2-normalised embedding per chunk, in order
//   data/ai/meta.json     model, dim, counts, built time
//
//   npm run ai:index       (needs Ollama running with the embedding model; OLLAMA_URL, EMBED_MODEL)
//
// Only Wikipedia (CC BY-SA) and Wikidata (CC0) text is embedded. TMDB's terms rule out using its
// content with AI, so TMDB overviews, keywords and tags never go into this index. Wikipedia and
// Wikidata responses are cached in .cache/wiki/; embeddings of unchanged passages are reused.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'data', 'ai');
const cacheDir = join(root, '.cache', 'wiki');
const OLLAMA = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const MODEL = process.env.EMBED_MODEL || 'mxbai-embed-large';
// Document prefix each embedding model expects (queries get theirs in lib/ai/provider.ts).
const DOC_PREFIX = MODEL.includes('nomic') ? 'search_document: ' : '';
const UA = 'reelgraph/0.1 (local film-map indexer; low request rate) node-fetch';
const CHUNK_WORDS = 220;

mkdirSync(cacheDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function cachedJson(url, init = {}) {
  const file = join(cacheDir, createHash('sha1').update(url + (init.body ?? '')).digest('hex') + '.json');
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { ...init, headers: { 'User-Agent': UA, Accept: 'application/json', ...init.headers } });
      if (res.ok) {
        const body = await res.text();
        writeFileSync(file, body);
        return JSON.parse(body);
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 5) {
        await sleep((Number(res.headers.get('retry-after')) || 0) * 1000 || 1000 * 2 ** attempt);
        continue;
      }
      throw new Error(`${url.slice(0, 80)}: HTTP ${res.status}`);
    } catch (e) {
      if (attempt >= 4) throw e;
      await sleep(1000 * 2 ** attempt);
    }
  }
}

// ---------- 1. Wikidata: TMDB id → English Wikipedia article and main subjects ----------

const map = JSON.parse(readFileSync(join(root, 'public', 'data', 'map.json'), 'utf8'));
const films = map.films.map(([id, , , , , title, year]) => ({ id, title, year }));
console.log(`Looking up ${films.length} films on Wikidata…`);

const info = new Map(); // tmdb id -> { wiki, subjects }
for (let b = 0; b < films.length; b += 200) {
  const ids = films.slice(b, b + 200).map(f => `"${f.id}"`).join(' ');
  const sparql = `SELECT ?tmdb ?article (GROUP_CONCAT(DISTINCT ?subjLabel; separator="|") AS ?subjects) WHERE {
    VALUES ?tmdb { ${ids} }
    ?item wdt:P4947 ?tmdb .
    ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> .
    OPTIONAL { ?item wdt:P921 ?subj . ?subj rdfs:label ?subjLabel . FILTER(LANG(?subjLabel) = "en") }
  } GROUP BY ?tmdb ?article`;
  const r = await cachedJson('https://query.wikidata.org/sparql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/sparql-results+json' },
    body: `query=${encodeURIComponent(sparql)}`,
  });
  for (const row of r.results.bindings) {
    const id = Number(row.tmdb.value);
    if (info.has(id)) continue; // one article per film
    const wiki = decodeURIComponent(row.article.value.replace('https://en.wikipedia.org/wiki/', '')).replace(/_/g, ' ');
    info.set(id, { wiki, subjects: row.subjects?.value ? row.subjects.value.split('|').slice(0, 12) : [] });
  }
}
console.log(`  ${info.size} films have an English Wikipedia article`);

// ---------- 2. Wikipedia: lead, plot and themes sections ----------

const KEEP = /^(plot|synopsis|premise|story|summary|plot summary|themes?|analysis|themes and analysis|style and themes)$/i;
const words = s => s.split(/\s+/).filter(Boolean);
const passagesOf = text => {
  const parts = text.split(/\n(?==+[^=\n]+=+[ \t]*\n)/);
  const lead = parts[0].trim();
  const out = [];
  if (lead) out.push(['lead', words(lead).slice(0, 160).join(' ')]);
  for (const p of parts.slice(1)) {
    const m = /^(=+)\s*(.+?)\s*=+[ \t]*\n?([\s\S]*)$/.exec(p.trim());
    if (!m || m[1].length !== 2 || !KEEP.test(m[2].trim())) continue;
    const body = m[3].replace(/^=+[^=\n]+=+[ \t]*$/gm, '').trim();
    const sec = /theme|analysis|style/i.test(m[2]) ? 'themes' : 'plot';
    const w = words(body).slice(0, sec === 'plot' ? 900 : 350);
    for (let i = 0; i < w.length; i += CHUNK_WORDS) {
      const piece = w.slice(i, i + CHUNK_WORDS);
      if (piece.length >= 40 || i === 0) out.push([sec, piece.join(' ')]);
    }
  }
  return out;
};

// Wikitext for 50 articles per request (single-page requests get rate-limited), turned into
// plain text: references, templates, files, tables and markup removed.
const plain = wt => {
  let t = wt.replace(/<!--[\s\S]*?-->/g, '').replace(/<ref[^>]*\/>/gi, '').replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '');
  for (let prev; prev !== t; ) (prev = t), (t = t.replace(/\{\{[^{}]*\}\}/g, ''));
  t = t.replace(/\{\|[\s\S]*?\|\}/g, '');
  t = t.replace(/\[\[(?:File|Image|Category):[^\[\]]*(?:\[\[[^\]]*\]\][^\[\]]*)*\]\]/gi, '');
  t = t.replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1').replace(/\[\[([^\]]*)\]\]/g, '$1');
  t = t.replace(/\[https?:[^\s\]]+ ([^\]]*)\]/g, '$1').replace(/\[https?:[^\]]*\]/g, '');
  t = t.replace(/'{2,}/g, '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/__[A-Z]+__/g, '');
  return t.replace(/^[*#:;]+\s*/gm, '').replace(/\n{3,}/g, '\n\n').trim();
};

console.log('Fetching Wikipedia articles…');
const withWiki = films.filter(f => info.has(f.id));
const textOf = new Map();
const titles = [...new Set(withWiki.map(f => info.get(f.id).wiki))];
for (let b = 0; b < titles.length; b += 50) {
  const batch = titles.slice(b, b + 50);
  const url = `https://en.wikipedia.org/w/api.php?action=query&prop=revisions&rvprop=content&rvslots=main&redirects=1&format=json&formatversion=2&titles=${encodeURIComponent(batch.join('|'))}`;
  const r = await cachedJson(url);
  const alias = new Map();
  for (const n of r.query?.normalized ?? []) alias.set(n.to, n.from);
  for (const n of r.query?.redirects ?? []) alias.set(n.to, alias.get(n.from) ?? n.from);
  for (const page of r.query?.pages ?? []) {
    const wt = page.revisions?.[0]?.slots?.main?.content;
    if (!wt) continue;
    textOf.set(alias.get(page.title) ?? page.title, plain(wt));
  }
  if ((b / 50) % 10 === 0) console.log(`  ${Math.min(b + 50, titles.length)}/${titles.length}`);
  await sleep(300);
}
const texts = withWiki.map(f => textOf.get(info.get(f.id).wiki) ?? '');

const chunks = [];
const filmsOut = {};
let withPlot = 0;
withWiki.forEach((f, n) => {
  const { wiki, subjects } = info.get(f.id);
  const passages = passagesOf(texts[n]);
  if (passages.some(([s]) => s === 'plot')) withPlot++;
  filmsOut[f.id] = { wiki, subjects };
  // No title in the passage: titles like "House" would match requests by wording alone.
  for (const [sec, text] of passages) chunks.push({ film: f.id, sec, text });
  if (subjects.length) chunks.push({ film: f.id, sec: 'subjects', text: `Main subjects: ${subjects.join(', ')}.` });
});
console.log(`  ${withPlot} films with a plot section, ${chunks.length} passages`);

// ---------- 3. Embeddings (reusing unchanged passages from the last build) ----------

const hash = t => createHash('sha1').update(`${MODEL}\n${DOC_PREFIX}${t}`).digest('hex');
const previous = new Map();
const prevChunks = join(outDir, 'chunks.json'), prevVecs = join(outDir, 'vectors.f32'), prevMeta = join(outDir, 'meta.json');
if (existsSync(prevChunks) && existsSync(prevVecs) && existsSync(prevMeta)) {
  const meta = JSON.parse(readFileSync(prevMeta, 'utf8'));
  if (meta.model === MODEL) {
    const old = JSON.parse(readFileSync(prevChunks, 'utf8'));
    const buf = readFileSync(prevVecs);
    const v = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    old.forEach((c, i) => previous.set(hash(c.text), v.slice(i * meta.dim, (i + 1) * meta.dim)));
  }
}

const todo = chunks.map((c, i) => i).filter(i => !previous.has(hash(chunks[i].text)));
console.log(`Embedding ${todo.length} passages with ${MODEL} (${chunks.length - todo.length} reused)…`);
const vecByIdx = new Map();
for (let b = 0; b < todo.length; b += 64) {
  const batch = todo.slice(b, b + 64);
  let res;
  try {
    res = await fetch(`${OLLAMA}/api/embed`, {
      method: 'POST',
      body: JSON.stringify({ model: MODEL, input: batch.map(i => DOC_PREFIX + chunks[i].text) }),
    });
  } catch {
    console.error(`Can't reach Ollama at ${OLLAMA}. Start it (ollama serve) and pull ${MODEL}.`);
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`Embedding failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    process.exit(1);
  }
  const { embeddings } = await res.json();
  batch.forEach((i, k) => vecByIdx.set(i, Float32Array.from(embeddings[k])));
  if ((b / 64) % 20 === 0) console.log(`  ${Math.min(b + 64, todo.length)}/${todo.length}`);
}

const dim = (vecByIdx.values().next().value ?? previous.values().next().value).length;
const all = new Float32Array(chunks.length * dim);
chunks.forEach((c, i) => {
  const v = vecByIdx.get(i) ?? previous.get(hash(c.text));
  const n = Math.hypot(...v) || 1;
  for (let d = 0; d < dim; d++) all[i * dim + d] = v[d] / n;
});

writeFileSync(join(outDir, 'chunks.json'), JSON.stringify(chunks));
writeFileSync(join(outDir, 'films.json'), JSON.stringify(filmsOut));
writeFileSync(prevVecs, Buffer.from(all.buffer));
writeFileSync(prevMeta, JSON.stringify({ model: MODEL, dim, chunks: chunks.length, films: Object.keys(filmsOut).length, withPlot, builtAt: new Date().toISOString() }, null, 2));
console.log(`${chunks.length} passages for ${Object.keys(filmsOut).length} films → data/ai/ (coverage ${Math.round((withPlot / films.length) * 100)}% with plots)`);
