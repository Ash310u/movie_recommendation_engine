// Step 1 of plans/chat-discovery.md: turn the conversation into a structured query (model output
// constrained to a JSON schema, then validated). Follow-ups edit the previous query.
import { z } from 'zod';
import { chatJson, type ChatMessage } from './provider';

export const QuerySchema = z.object({
  intent: z.enum(['find', 'like', 'question', 'chat']),
  about: z.string().max(400),
  keywords: z.array(z.string().max(60)).max(8),
  like: z.array(z.object({ title: z.string().max(120), year: z.number().int().nullable() })).max(5),
  filters: z.object({
    genres: z.array(z.string()).max(4),
    yearFrom: z.number().int().nullable(),
    yearTo: z.number().int().nullable(),
    languages: z.array(z.string().length(2)).max(6),
    maxRuntime: z.number().int().nullable(),
  }),
  exclude: z.object({ genres: z.array(z.string()).max(6), about: z.string().max(200) }),
  count: z.number().int().min(1).max(12),
  usePicks: z.boolean(),
});
export type Query = z.infer<typeof QuerySchema>;

export const emptyQuery = (): Query => ({
  intent: 'find',
  about: '',
  keywords: [],
  like: [],
  filters: { genres: [], yearFrom: null, yearTo: null, languages: [], maxRuntime: null },
  exclude: { genres: [], about: '' },
  count: 8,
  usePicks: false,
});

const jsonSchema = z.toJSONSchema(QuerySchema);

export interface Turn {
  role: 'user' | 'assistant';
  text: string;
}

export async function understand(
  turns: Turn[],
  prev: { query: Query | null; results: { title: string; year: number }[] },
  picks: string[],
  genres: string[],
  signal?: AbortSignal,
): Promise<Query> {
  const system = `You turn a film request into a search query for a map of about 2,500 well-known films.
Return JSON only, matching the schema. Field meanings:
- intent: "find" (films matching a description), "like" (films similar to named films), "question" (a question about one or more named films), "chat" (greetings or anything not about finding films).
Leave every filter, exclude and keyword empty unless the visitor's own words ask for it; most requests have none.
- about: one or two short sentences (under 40 words) written like a plot summary of the kind of film wanted, naming concrete things that would happen or be seen in it (e.g. "rich lifestyle" -> "The story follows wealthy people living in luxury: mansions, yachts, lavish parties, designer clothes and extravagant spending among high society."). Empty for pure "like" requests.
- keywords: specific names or rare words to match literally: people, places, objects ("Hitchcock", "Tokyo", "chess"). Not generic words.
- like: films the visitor names as reference points ("like X", "similar to X", "X but funnier", "if I loved X"), or the films a follow-up points at ("more like #2" means result 2 of the previous answer). Film titles go here, never in keywords.
- filters.genres: only from this list, and only when the visitor literally names a genre: ${genres.join(', ')}. All listed genres must match, so "crime thriller" -> ["Crime","Thriller"]. Moods ("suspense", "dark", "feel-good") and people's names are not genres: leave genres empty for them.
- filters.yearFrom/yearTo: from decades or eras ("90s" -> 1990..1999, "recent" -> ${new Date().getFullYear() - 6}..null, "not before 2000" -> 2000..null).
- filters.languages: ISO 639-1 codes when a language or country is asked for ("Korean" -> ["ko"], "Bollywood" -> ["hi"]).
- filters.maxRuntime: minutes, when length is asked for ("not too long" -> 120, "short" -> 100).
- exclude.genres / exclude.about: what the visitor does not want ("no horror", "nothing too violent").
- count: how many films; 8 unless asked.
- usePicks: true if they refer to "my likes" or "my picks".
If this is a follow-up ("only comedies", "darker", "older ones", "more like the second"), start from the previous query and change only what the follow-up asks; keep everything else.`;

  const context = [
    prev.query ? `Previous query: ${JSON.stringify(prev.query)}` : 'No previous query.',
    prev.results.length ? `Previous results: ${prev.results.map((r, n) => `#${n + 1} ${r.title} (${r.year})`).join('; ')}` : '',
    picks.length ? `Visitor's liked films: ${picks.join('; ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const history = turns.slice(-7, -1).map(t => `${t.role === 'user' ? 'Visitor' : 'Assistant'}: ${t.text.slice(0, 400)}`).join('\n');
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: `${context}\n${history ? `Conversation so far:\n${history}\n` : ''}New message: ${turns[turns.length - 1].text}` },
  ];
  const raw = await chatJson(messages, jsonSchema, signal);
  const parsed = QuerySchema.safeParse(raw);
  if (!parsed.success) throw new Error(`The model returned an invalid query: ${parsed.error.issues[0]?.message}`);
  const q = sanitize(parsed.data, turns, prev);
  // Keep only genres the map knows, matched case-insensitively.
  const known = new Map(genres.map(g => [g.toLowerCase(), g]));
  q.filters.genres = q.filters.genres.map(g => known.get(g.toLowerCase())).filter((g): g is string => !!g);
  q.exclude.genres = q.exclude.genres.map(g => known.get(g.toLowerCase())).filter((g): g is string => !!g);
  q.filters.languages = q.filters.languages.map(l => l.toLowerCase());
  return q;
}

// Small models fill in filters nobody asked for (English only, 2010+, "no horror" on a zombie
// request). Keep a filter only if the visitor's words support it, or it carries over unchanged
// from the previous query in a follow-up.
const LANG_WORDS: Record<string, string[]> = {
  en: ['english', 'american', 'british', 'hollywood'], fr: ['french', 'france'], ja: ['japanese', 'japan', 'anime'],
  ko: ['korean', 'korea'], es: ['spanish', 'spain', 'mexican', 'latin'], it: ['italian', 'italy'], de: ['german', 'germany'],
  hi: ['hindi', 'bollywood', 'indian', 'india'], zh: ['chinese', 'china', 'mandarin', 'taiwan'], cn: ['cantonese', 'hong kong'],
  ru: ['russian'], sv: ['swedish'], da: ['danish'], pt: ['portuguese', 'brazil'], fa: ['iranian', 'persian'], tr: ['turkish'],
};
const GENRE_WORDS: Record<string, string[]> = {
  'Science Fiction': ['sci-fi', 'scifi', 'science fiction', 'sci fi'], Animation: ['animated', 'animation', 'cartoon', 'anime'],
  Comedy: ['comedy', 'comedies', 'funny', 'romcom', 'rom-com'], Romance: ['romance', 'romantic', 'romcom', 'rom-com', 'love story'],
  Music: ['musical', 'music'], Documentary: ['documentary'], 'TV Movie': ['tv movie'], War: ['war'], Western: ['western'],
};
const NEGATION = /\b(no|not|without|nothing|avoid|less|don'?t|never|skip|except|but not)\b/;
const YEAR_WORDS = /\b(\d{2,4}s?|recent|new|newer|latest|modern|old|older|classic|vintage|before|after|since|until|decade|era|century)\b/;
const RUNTIME_WORDS = /\b(short|long|length|minutes?|mins?|hours?|runtime|quick)\b/;

function sanitize(q: Query, turns: Turn[], prev: { query: Query | null; results: { title: string }[] }): Query {
  const prevQ = prev.query;
  const text = turns.filter(t => t.role === 'user').slice(-1)[0].text.toLowerCase();
  const said = (words: string[]) => words.some(w => new RegExp(`(^|[^a-z])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(text));
  const was = <T>(get: (x: Query) => T, v: T) => prevQ !== null && JSON.stringify(get(prevQ)) === JSON.stringify(v);
  const genreSaid = (g: string) => said([g.toLowerCase(), ...(GENRE_WORDS[g] ?? [])]);
  const keepGenre = (g: string, list: (x: Query) => string[]) => genreSaid(g) || (prevQ !== null && list(prevQ).includes(g));

  q.filters.genres = q.filters.genres.filter(g => keepGenre(g, x => x.filters.genres));
  q.exclude.genres = q.exclude.genres.filter(g => (NEGATION.test(text) && genreSaid(g)) || (prevQ?.exclude.genres.includes(g) ?? false));
  if (!NEGATION.test(text) && !was(x => x.exclude.about, q.exclude.about)) q.exclude.about = '';
  if (!YEAR_WORDS.test(text) && !was(x => [x.filters.yearFrom, x.filters.yearTo], [q.filters.yearFrom, q.filters.yearTo])) {
    q.filters.yearFrom = prevQ?.filters.yearFrom ?? null;
    q.filters.yearTo = prevQ?.filters.yearTo ?? null;
  }
  q.filters.languages = q.filters.languages.filter(l => said(LANG_WORDS[l] ?? []) || (prevQ?.filters.languages.includes(l) ?? false));
  if (!RUNTIME_WORDS.test(text) && !was(x => x.filters.maxRuntime, q.filters.maxRuntime)) q.filters.maxRuntime = prevQ?.filters.maxRuntime ?? null;
  // Keywords are for names and rare words the visitor typed, not the model's own ideas.
  const userText = turns.filter(t => t.role === 'user').map(t => t.text.toLowerCase()).join(' ');
  q.keywords = q.keywords.filter(k => k.trim().length > 1 && userText.includes(k.toLowerCase().trim()));
  // Reference films: ones the visitor typed, or earlier results a follow-up points at ("#2").
  const loose = (t: string) => t.toLowerCase().replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const typed = loose(userText);
  const earlier = new Set([...prev.results.map(r => loose(r.title)), ...(prevQ?.like ?? []).map(l => loose(l.title))]);
  q.like = q.like.filter(l => {
    const t = loose(l.title);
    return t.length > 1 && (typed.includes(t) || earlier.has(t));
  });
  if (!/\b(my (likes|picks|favou?rites)|i liked|i('ve)? loved)\b/.test(text) && !prevQ?.usePicks) q.usePicks = false;
  return q;
}

/** Without the model: a keyword query straight from the message. */
export function fallbackQuery(text: string): Query {
  return { ...emptyQuery(), keywords: [text] };
}
