// Types and loading for the files written by scripts/build-data.mjs.

export interface Kind { id: string; name: string; color: string; cx: number; cy: number; r: number; count: number }
export interface Sub { kind: number; name: string; cx: number; cy: number; size: number }

export interface Film {
  i: number;
  id: number;
  kind: number;
  x: number;
  y: number;
  pop: number;
  title: string;
  year: number;
  poster: string;
  color: string;
  lang: string;
  sub: number;
}

export interface MapData {
  builtAt: string;
  kinds: Kind[];
  subs: Sub[];
  languages: { code: string; count: number }[];
  films: Film[];
  edges: [number, number, number][];
  scale: number[];
}

export interface Detail {
  imdb: string | null;
  /** minutes */
  runtime: number | null;
  rating: number;
  votes: number;
  director: string | null;
  cast: string[];
  overview: string;
  /** [dim (or -1 when the tag isn't in the vocabulary), label] */
  chips: [number, string][];
  /** [film index, match %, reasons] */
  nb: [number, number, string[]][];
}

export interface Tags {
  /** [key, label, df], indexed by dim. Keys: k: keyword, g: genre, d: director, c: cast, y: decade. */
  vocab: [string, string, number][];
  /** per film: flat [dim, weight, dim, weight, …], L2-normalised */
  vecs: number[][];
}

type Row = [number, number, number, number, number, string, number, string, string, string, number];

export async function loadMap(): Promise<MapData> {
  const res = await fetch('/data/map.json');
  if (!res.ok) throw new Error(`map.json: HTTP ${res.status}`);
  const raw = await res.json();
  const films = (raw.films as Row[]).map(([id, kind, x, y, pop, title, year, poster, color, lang, sub], i) => ({
    i, id, kind, x, y, pop, title, year, poster, color, lang, sub,
  }));
  return { ...raw, films };
}

export const loadJson = <T>(name: string): Promise<T> =>
  fetch(`/data/${name}.json`).then(r => {
    if (!r.ok) throw new Error(`${name}.json: HTTP ${r.status}`);
    return r.json() as Promise<T>;
  });

export const IMG = 'https://image.tmdb.org/t/p/';

const LANG_NAMES: Record<string, string> = {
  en: 'English', fr: 'French', es: 'Spanish', de: 'German', it: 'Italian', ja: 'Japanese', ko: 'Korean',
  zh: 'Chinese', cn: 'Cantonese', hi: 'Hindi', ru: 'Russian', pt: 'Portuguese', sv: 'Swedish', da: 'Danish',
  no: 'Norwegian', fi: 'Finnish', nl: 'Dutch', pl: 'Polish', tr: 'Turkish', ar: 'Arabic', th: 'Thai',
  cs: 'Czech', hu: 'Hungarian', el: 'Greek', he: 'Hebrew', fa: 'Persian', id: 'Indonesian', ta: 'Tamil',
  te: 'Telugu', ml: 'Malayalam', ro: 'Romanian', uk: 'Ukrainian', vi: 'Vietnamese', is: 'Icelandic',
  ga: 'Irish', tl: 'Tagalog', xx: 'No language',
};
export const langName = (code: string) => LANG_NAMES[code] ?? code.toUpperCase();
