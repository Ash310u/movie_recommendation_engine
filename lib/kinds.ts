// The 13 kinds of film on the map. Grown from mov/src/orbit/moods.ts. Shared by the app and by
// scripts/build-data.mjs (Node strips the types), so keep this file erasable TypeScript with no
// browser APIs.

export interface Kind {
  id: string;
  name: string;
  /** Dark-theme colour (plans/vector-map-ui.md). */
  color: string;
  /** Position on the ring, 1 at the top, then clockwise. Related kinds sit side by side. */
  ring: number;
  /** Lower wins when a film's genres match several kinds. */
  priority: number;
  /** TMDB movie genre ids. */
  genres: number[];
}

export const KINDS: Kind[] = [
  { id: 'drama', name: 'Drama', color: '#6fbf8e', ring: 1, priority: 13, genres: [18] },
  { id: 'romance', name: 'Romance', color: '#ff7a9a', ring: 2, priority: 7, genres: [10749] },
  { id: 'music', name: 'Music & Musicals', color: '#d77be0', ring: 3, priority: 5, genres: [10402] },
  { id: 'comedy', name: 'Comedy', color: '#f2c14e', ring: 4, priority: 9, genres: [35] },
  { id: 'family', name: 'Family & Animation', color: '#ffb067', ring: 5, priority: 2, genres: [10751, 16] },
  { id: 'fantasy', name: 'Fantasy', color: '#a98bf0', ring: 6, priority: 4, genres: [14] },
  { id: 'adventure', name: 'Adventure & Western', color: '#c9a26b', ring: 7, priority: 10, genres: [12, 37] },
  { id: 'action', name: 'Action', color: '#ff8a4c', ring: 8, priority: 11, genres: [28] },
  { id: 'scifi', name: 'Science Fiction', color: '#4fb6f0', ring: 9, priority: 3, genres: [878] },
  { id: 'horror', name: 'Horror', color: '#d2433f', ring: 10, priority: 1, genres: [27] },
  { id: 'thriller', name: 'Thriller', color: '#9aa3d9', ring: 11, priority: 8, genres: [53] },
  { id: 'crime', name: 'Crime & Mystery', color: '#5c7cfa', ring: 12, priority: 6, genres: [80, 9648] },
  { id: 'history', name: 'History & War', color: '#b9b27a', ring: 13, priority: 12, genres: [36, 10752] },
];

/** Documentary and TV Movie are left off the map. */
export const EXCLUDED_GENRES = [99, 10770];

const BY_PRIORITY = [...KINDS].sort((a, b) => a.priority - b.priority);

/** The kind a film belongs to, by the priority order; Drama catches the rest. */
export function kindFor(genreIds: number[]): string | null {
  if (genreIds.some(g => EXCLUDED_GENRES.includes(g))) return null;
  return (BY_PRIORITY.find(k => k.genres.some(g => genreIds.includes(g))) ?? KINDS[0]).id;
}

/** How much a film belongs to each kind: 1 for its primary kind, 0.5 for others its genres touch, L2-normalised. */
export function kindVector(genreIds: number[], primary: string): number[] {
  const v = KINDS.map(k => (k.id === primary ? 1 : k.genres.some(g => genreIds.includes(g)) ? 0.5 : 0));
  const n = Math.hypot(...v) || 1;
  return v.map(x => x / n);
}
