// Measures the chat assistant's search (plans/chat-discovery.md 2.7) against data/ai/eval.json.
// Needs the app running (npm run dev or start) with Ollama up:
//   BASE=http://localhost:3000 npm run ai:eval
// Reads each answer only up to its results event, so it measures understanding + retrieval.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE || 'http://localhost:3000';
const { cases } = JSON.parse(readFileSync(join(root, 'data', 'ai', 'eval.json'), 'utf8'));
const map = JSON.parse(readFileSync(join(root, 'public', 'data', 'map.json'), 'utf8'));
const detail = JSON.parse(readFileSync(join(root, 'public', 'data', 'detail.json'), 'utf8'));
const tags = JSON.parse(readFileSync(join(root, 'public', 'data', 'tags.json'), 'utf8'));
const idx = new Map(map.films.map((f, i) => [f[0], i]));
const genreLabel = new Map(tags.vocab.map(([k, l], d) => [d, k.startsWith('g:') ? l : null]));
const genresOf = i => new Set(detail[i].chips.map(([d]) => genreLabel.get(d)).filter(Boolean));
const norm = s => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function ask(q) {
  const t0 = performance.now();
  const ctrl = new AbortController();
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', text: q }], state: null }),
    signal: ctrl.signal,
  });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    for (let end; (end = buf.indexOf('\n\n')) >= 0; ) {
      const block = buf.slice(0, end);
      buf = buf.slice(end + 2);
      const ev = /^event: (.+)$/m.exec(block)?.[1];
      const data = JSON.parse(/^data: (.+)$/m.exec(block)?.[1] ?? 'null');
      if (ev === 'results' || ev === 'error') {
        ctrl.abort();
        return { ev, data, ms: performance.now() - t0 };
      }
    }
  }
  return { ev: 'none', data: null, ms: performance.now() - t0 };
}

let pass = 0, hitCases = 0, hitPass = 0, violations = 0;
const times = [];
for (const c of cases) {
  let r;
  try {
    r = await ask(c.q);
  } catch (e) {
    if (e.name === 'AbortError') continue;
    console.error(`Can't reach ${BASE}: ${e.message}`);
    process.exit(1);
  }
  times.push(r.ms);
  const problems = [];
  if (r.ev === 'error') problems.push(`error: ${r.data.message}`);
  const films = (r.data?.films ?? []).map(f => idx.get(f.id));
  const titles = films.map(i => map.films[i][5]);
  const ck = c.check ?? {};
  if (ck.chat) {
    if (r.data?.films !== null) problems.push('expected small talk, got a search');
  } else if (r.ev === 'results' && !films.length) problems.push('no results');
  for (const i of films) {
    const [, , , , , title, year, , , lang] = map.films[i];
    const bad = [];
    if (ck.yearFrom && year < ck.yearFrom) bad.push(`${year}`);
    if (ck.yearTo && year > ck.yearTo) bad.push(`${year}`);
    if (ck.languages && !ck.languages.includes(lang)) bad.push(lang);
    if (ck.maxRuntime && detail[i].runtime > ck.maxRuntime) bad.push(`${detail[i].runtime} min`);
    for (const g of ck.genres ?? []) if (!genresOf(i).has(g)) bad.push(`not ${g}`);
    for (const g of ck.notGenres ?? []) if (genresOf(i).has(g)) bad.push(g);
    if ((ck.notTitles ?? []).includes(title)) bad.push('is the reference film');
    if (bad.length) (violations++, problems.push(`${title}: ${bad.join(', ')}`));
  }
  if (c.expect) {
    hitCases++;
    const want = new Set(c.expect.map(norm));
    const got = titles.filter(t => want.has(norm(t)));
    if (got.length >= (c.min ?? 1)) hitPass++;
    else problems.push(`expected ${c.min ?? 1}+ of the list, found ${got.length}${got.length ? ` (${got.join(', ')})` : ''}`);
  }
  if (!problems.length) pass++;
  console.log(`${problems.length ? 'FAIL' : 'PASS'}  ${(r.ms / 1000).toFixed(1)}s  ${c.q}`);
  console.log(`      ${titles.join(' · ') || '(none)'}`);
  for (const p of problems) console.log(`      ! ${p}`);
}
times.sort((a, b) => a - b);
console.log(`\n${pass}/${cases.length} passed · hit-rate ${hitPass}/${hitCases} · filter violations ${violations} · median time to results ${(times[times.length >> 1] / 1000).toFixed(1)}s`);
