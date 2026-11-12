// Recommendations from picks, in plain arithmetic over the TF-IDF tag vectors (engine plan,
// Decision 4): Rocchio for the query, cosine for candidates, MMR for variety.

export type Vec = Map<number, number>;

export const toVec = (flat: number[]): Vec => {
  const v: Vec = new Map();
  for (let q = 0; q < flat.length; q += 2) v.set(flat[q], flat[q + 1]);
  return v;
};

export const dot = (a: Vec, b: Vec) => {
  if (a.size > b.size) [a, b] = [b, a];
  let s = 0;
  for (const [d, w] of a) {
    const o = b.get(d);
    if (o !== undefined) s += w * o;
  }
  return s;
};

/** The shared tags of two films, strongest first. */
export const shared = (a: Vec, b: Vec) => {
  const parts: [number, number][] = [];
  for (const [d, w] of a) {
    const o = b.get(d);
    if (o !== undefined) parts.push([d, w * o]);
  }
  return parts.sort((p, q) => q[1] - p[1]).map(p => p[0]);
};

export interface Rec { film: number; score: number; from: number }

/**
 * q = normalise(mean(liked) - 0.5·mean(disliked)), negatives dropped. Then the 60 nearest films
 * that aren't picks, re-ranked by MMR (λ = 0.7) and cut to `k`. Each result says which liked film
 * it is closest to, for the thread on the map.
 */
export function recommend(vecs: Vec[], like: number[], dislike: number[], k = 12): Rec[] {
  if (!like.length) return [];
  const q: Vec = new Map();
  for (const i of like) for (const [d, w] of vecs[i]) q.set(d, (q.get(d) ?? 0) + w / like.length);
  for (const i of dislike) for (const [d, w] of vecs[i]) q.set(d, (q.get(d) ?? 0) - (0.5 * w) / dislike.length);
  for (const [d, w] of q) if (w <= 0) q.delete(d);
  const norm = Math.hypot(...q.values()) || 1;
  for (const [d, w] of q) q.set(d, w / norm);

  const picks = new Set([...like, ...dislike]);
  const cands = vecs
    .map((v, i) => ({ i, s: picks.has(i) ? -1 : dot(q, v) }))
    .filter(c => c.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, 60);

  const out: { i: number; s: number }[] = [];
  const LAMBDA = 0.7;
  while (out.length < k && cands.length) {
    let best = 0, bestScore = -Infinity;
    cands.forEach((c, n) => {
      const redundancy = out.reduce((m, o) => Math.max(m, dot(vecs[c.i], vecs[o.i])), 0);
      const mmr = LAMBDA * c.s - (1 - LAMBDA) * redundancy;
      if (mmr > bestScore) (bestScore = mmr), (best = n);
    });
    out.push(cands.splice(best, 1)[0]);
  }
  return out.map(({ i, s }) => {
    let from = like[0], fs = -1;
    for (const l of like) {
      const d = dot(vecs[i], vecs[l]);
      if (d > fs) (fs = d), (from = l);
    }
    return { film: i, score: s, from };
  });
}

/** A cosine as the map's match %: its percentile among the stored neighbour scores, over 55–99. */
export function matchOf(scale: number[], s: number) {
  let lo = 0, hi = scale.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (scale[mid] < s) lo = mid + 1;
    else hi = mid;
  }
  return Math.min(99, Math.max(55, Math.round(55 + 44 * (lo / (scale.length - 1)))));
}
