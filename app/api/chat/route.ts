// POST /api/chat: the chat assistant (plans/chat-discovery.md 2.6). Streams server-sent events:
//   step     { step: 'understanding' | 'searching' | 'writing' }
//   results  { films: [{ id, n, source }], query, offline }   — sent as soon as the search is done
//   text     { text }                                           — reply text, with [n] film markers
//   why      { n, text }
//   done     { suggestions, state: { query, results } }
//   error    { message, offline? }
import { z } from 'zod';
import { explain, reply, type AnswerFilm, type Mode } from '../../../lib/ai/answer';
import { corpus, findFilm, type Corpus } from '../../../lib/ai/corpus';
import { CHAT_MODEL, embed, EMBED_MODEL, OfflineError } from '../../../lib/ai/provider';
import { filmPassages, passes, search, type Hit } from '../../../lib/ai/search';
import { fallbackQuery, QuerySchema, understand, type Query } from '../../../lib/ai/understand';
import { take } from '../../../lib/rateLimit';

const Body = z.object({
  messages: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().min(1).max(2000) })).min(1).max(40),
  state: z.object({ query: QuerySchema.nullable(), results: z.array(z.number().int()).max(12) }).nullable(),
  picks: z.object({ like: z.array(z.number().int()).max(5), dislike: z.array(z.number().int()).max(5) }).optional(),
});

const TIMEOUT_MS = 60_000;
/** Messages per address per 10 minutes (CHAT_RATE). */
const RATE = Number(process.env.CHAT_RATE) || 30;

export async function POST(req: Request) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'local';
  if (!take(`chat:${ip}`, RATE, 10 * 60_000)) return Response.json({ error: 'Too many messages; wait a few minutes.' }, { status: 429 });

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Bad request' }, { status: 400 });
  const { messages, state, picks } = parsed.data;
  const last = messages[messages.length - 1];
  if (last.role !== 'user' || last.text.length > 500) return Response.json({ error: 'The last message must be yours, up to 500 characters.' }, { status: 400 });

  const c = corpus();
  const signal = AbortSignal.any([req.signal, AbortSignal.timeout(TIMEOUT_MS)]);
  const enc = new TextEncoder();

  const stream = new ReadableStream({
    async start(ctrl) {
      const send = (event: string, data: unknown) => ctrl.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      try {
        await run(c, messages, state, picks, send, signal);
      } catch (e) {
        const offline = e instanceof OfflineError;
        const timedOut = (e as Error).name === 'TimeoutError' || (e as Error).name === 'AbortError';
        send('error', {
          message: offline ? 'The assistant isn’t running (start Ollama).' : timedOut ? 'That took too long. Try again?' : 'Something went wrong. Try again?',
          offline,
        });
        if (!offline && !timedOut) console.error('chat:', e);
      } finally {
        ctrl.close();
      }
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform' } });
}

type Send = (event: string, data: unknown) => void;

async function run(
  c: Corpus,
  messages: z.infer<typeof Body>['messages'],
  state: z.infer<typeof Body>['state'],
  picks: z.infer<typeof Body>['picks'],
  send: Send,
  signal: AbortSignal,
) {
  const idx = (ids: number[]) => ids.map(id => c.byId.get(id)?.i).filter((i): i is number => i !== undefined);
  const prevResults = idx(state?.results ?? []);
  const likeIdx = idx(picks?.like ?? []), dislikeIdx = idx(picks?.dislike ?? []);

  // 1. Understand. Without the model, fall back to a keyword search of the message.
  send('step', { step: 'understanding' });
  let query: Query, offline = false;
  try {
    query = await understand(
      messages,
      { query: state?.query ?? null, results: prevResults.map(i => c.films[i]) },
      likeIdx.map(i => `${c.films[i].title} (${c.films[i].year})`),
      c.genreNames,
      signal,
    );
  } catch (e) {
    if (!(e instanceof OfflineError)) throw e;
    offline = true;
    query = fallbackQuery(messages[messages.length - 1].text);
  }

  // A keyword that is exactly a film's title is a reference film, not a search word.
  for (const k of [...query.keywords]) {
    const f = findFilm(c, k);
    if (f && f.title.toLowerCase() === k.toLowerCase().trim() && !query.like.some(l => findFilm(c, l.title, l.year) === f)) {
      query.like.push({ title: f.title, year: f.year });
      query.keywords = query.keywords.filter(x => x !== k);
    }
  }

  if (query.intent === 'chat') {
    send('results', { films: null, query, offline, model: CHAT_MODEL });
    await write(c, messages, [], 'chat', '', query, prevResults, send, signal);
    return;
  }

  // 2–3. Search.
  send('step', { step: 'searching' });
  const named = query.like.map(l => findFilm(c, l.title, l.year)).filter((f): f is NonNullable<typeof f> => !!f);
  const like = [...new Set([...named.map(f => f.i), ...(query.usePicks ? likeIdx : [])])];
  let hits: Hit[] = [];
  let note = '';
  if (query.intent === 'question' && named.length) {
    hits = named.map(f => ({ film: f, score: 1, passage: filmPassages(c, f.i, 2).join(' ') || null, via: ['named'] }));
  } else {
    let aboutVec: Float32Array | null = null, excludeVec: Float32Array | null = null;
    if (!offline && c.dim && (query.about || query.exclude.about)) {
      if (c.embedModel !== EMBED_MODEL) throw new Error(`data/ai was built with ${c.embedModel}, but EMBED_MODEL is ${EMBED_MODEL}`);
      const texts = [query.about || query.keywords.join(' '), query.exclude.about].filter(Boolean);
      const vecs = await embed(texts, 'query', signal);
      aboutVec = query.about || query.keywords.length ? vecs[0] : null;
      excludeVec = query.exclude.about ? vecs[vecs.length - 1] : null;
    }
    const r = search(c, { query, aboutVec, excludeVec, like, dislike: query.usePicks ? dislikeIdx : [] });
    hits = r.hits;
    if (r.hits.length < query.count && r.filteredOut) note = `Only ${r.hits.length} films passed the filters; ${r.filteredOut} close matches were left out by them. Say so and offer to relax the filters.`;
    const missing = query.like.filter(l => !findFilm(c, l.title, l.year));
    if (missing.length) note += ` These named films aren't on the map: ${missing.map(m => m.title).join(', ')}; say so briefly.`;
    if (named.some(f => !passes(f, query))) note += ' Some named reference films fall outside the filters; that is fine.';
  }

  const results = hits.map((h, k) => ({ id: h.film.id, n: k + 1, source: h.passage ? 'wikipedia' : 'tags', via: h.via }));
  send('results', { films: results, query, offline, model: CHAT_MODEL, searched: c.films.length });

  // 4. Answer.
  if (offline) {
    send('text', {
      text: hits.length
        ? `The assistant isn’t running, so these are plain keyword matches: ${hits.map((h, k) => `${h.film.title} [${k + 1}]`).join(', ')}.`
        : 'The assistant isn’t running, and no keyword matches turned up. Start Ollama for full answers.',
    });
    send('done', { suggestions: [], state: { query, results: hits.map(h => h.film.id) } });
    return;
  }
  const films: AnswerFilm[] = hits.map((h, k) => ({ n: k + 1, title: h.film.title, year: h.film.year, passage: h.passage }));
  await write(c, messages, films, hits.length ? (query.intent === 'question' ? 'question' : 'find') : 'empty', note.trim(), query, hits.map(h => h.film.i), send, signal);
}

async function write(
  c: Corpus,
  messages: z.infer<typeof Body>['messages'],
  films: AnswerFilm[],
  mode: Mode,
  note: string,
  query: Query,
  resultIdx: number[],
  send: Send,
  signal: AbortSignal,
) {
  send('step', { step: 'writing' });
  for await (const text of reply(messages, films, mode, note, signal)) send('text', { text });
  let suggestions: string[] = [];
  if (films.length) {
    const ex = await explain(messages, films, signal);
    for (const [n, text] of ex.whys) send('why', { n, text });
    suggestions = ex.suggestions;
  }
  send('done', { suggestions, state: { query, results: resultIdx.map(i => c.films[i].id) } });
}
