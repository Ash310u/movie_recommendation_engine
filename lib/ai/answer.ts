// Step 4 of plans/chat-discovery.md, in two calls:
//  1. reply()   streams a few sentences about only the films the search found, with [n] markers;
//  2. explain() returns one "why it fits" line per film and follow-up suggestions as JSON, each
//     line tied to its film by number and title, so a small model can't attach it to the wrong one.
import { z } from 'zod';
import { chatJson, chatStream, type ChatMessage } from './provider';
import type { Turn } from './understand';

export interface AnswerFilm {
  n: number;
  title: string;
  year: number;
  passage: string | null;
}

export type Mode = 'find' | 'question' | 'empty' | 'chat';

const STYLE = `You are reelgraph, a warm, concise film guide on a map of about 2,500 films. Plain text only: no markdown, no lists, no headings.`;

const SYSTEM: Record<Mode, string> = {
  find: `${STYLE}
You may only talk about the numbered films given; never name any other film.
Refer to each film by its number in single square brackets, like [3], instead of its title.
Write at most 90 words in 3-4 sentences: group similar films together so each sentence covers two or three of them, with a few specific words about each from its passage. Mention every numbered film once. End with a short question offering a direction (lighter, darker, older, …).`,
  question: `${STYLE}
Answer the visitor's question in 2-4 sentences using only the passages about the numbered films. Refer to a film by its number in square brackets, e.g. [1]. If the passages don't say, say you don't know.`,
  empty: `${STYLE}
No films on the map matched this time. In 1-2 sentences say so and suggest how to broaden the request. Don't name any films.`,
  chat: `${STYLE}
The visitor's message isn't a film search. Reply in 1-2 friendly sentences, then invite them to describe a film they'd like (a mood, a story, a film they loved). Don't name any films.`,
};

const filmList = (films: AnswerFilm[], words: number) =>
  films.map(f => `[${f.n}] ${f.title} (${f.year})${f.passage ? `: ${f.passage.split(/\s+/).slice(0, words).join(' ')}` : ''}`).join('\n\n');

/** The reply text, streamed. Stops if the model starts adding its own extra sections. */
export async function* reply(turns: Turn[], films: AnswerFilm[], mode: Mode, note: string, signal?: AbortSignal): AsyncGenerator<string> {
  // Only the visitor's earlier messages: earlier replies number different films, and a small
  // model copies them.
  const history = turns.slice(-7, -1).filter(t => t.role === 'user').map(t => `Visitor: ${t.text.slice(0, 300)}`).join('\n');
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM[mode] },
    {
      role: 'user',
      content: `${history ? `Earlier:\n${history}\n\n` : ''}Visitor: ${turns[turns.length - 1].text}${note ? `\nNote: ${note}` : ''}${films.length ? `\n\nFilms:\n${filmList(films, 110)}` : ''}`,
    },
  ];
  // Text is passed on as it arrives, holding back a little in case an extra section is starting.
  let buf = '', sent = 0, started = false;
  const STOP = /\n\s*(?:WHY\b|SUGGEST|Films?:|\[\d+\]\s*[^\n]*\(\d{4}\))/i;
  for await (const piece of chatStream(messages, signal)) {
    buf += piece;
    if (!started) {
      if (/^\s*R?E?P?L?Y?:?\s*$/i.test(buf)) continue; // could still be a "REPLY:" tag
      buf = buf.replace(/^\s*(REPLY\s*:\s*)?/i, '');
      started = true;
    }
    const stop = STOP.exec(buf);
    const upto = stop ? stop.index : Math.max(sent, buf.length - 16);
    if (upto > sent) {
      yield buf.slice(sent, upto);
      sent = upto;
    }
    if (stop) return;
  }
  if (buf.length > sent) yield buf.slice(sent).trimEnd();
}

const Explain = z.object({
  reasons: z.array(z.object({ n: z.number().int(), title: z.string(), why: z.string() })),
  suggestions: z.array(z.string()),
});

/** One line per film on why it fits, and three follow-up requests. */
export async function explain(turns: Turn[], films: AnswerFilm[], signal?: AbortSignal) {
  const schema = {
    type: 'object',
    properties: {
      reasons: {
        type: 'array',
        minItems: films.length,
        maxItems: films.length,
        items: { type: 'object', properties: { n: { type: 'integer' }, title: { type: 'string' }, why: { type: 'string' } }, required: ['n', 'title', 'why'] },
      },
      suggestions: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'string' } },
    },
    required: ['reasons', 'suggestions'],
  };
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `For each numbered film, in order, give its number, its exact title, and "why": at most 12 words on why it fits the visitor's request, based on its passage, without repeating the title. Then "suggestions": three short follow-up messages the visitor could send next (2-5 words each), fitted to this request, e.g. "Only comedies", "Something more recent", "More like #2". Return JSON only.`,
    },
    { role: 'user', content: `Visitor: ${turns[turns.length - 1].text}\n\nFilms:\n${filmList(films, 90)}` },
  ];
  const parsed = Explain.safeParse(await chatJson(messages, schema, signal));
  if (!parsed.success) return { whys: new Map<number, string>(), suggestions: [] as string[] };
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const whys = new Map<number, string>();
  parsed.data.reasons.forEach((r, k) => {
    // Trust the title over the number, then the number, then the position.
    const film = films.find(f => norm(f.title) === norm(r.title)) ?? films.find(f => f.n === r.n) ?? films[k];
    if (film && !whys.has(film.n) && r.why.trim()) whys.set(film.n, r.why.trim().replace(/^["']|["']$/g, ''));
  });
  const asked = norm(turns[turns.length - 1].text);
  const suggestions = parsed.data.suggestions.map(s => s.trim().replace(/^["']|["']$/g, '')).filter(s => s && s.length <= 60 && norm(s) !== asked);
  return { whys, suggestions };
}
