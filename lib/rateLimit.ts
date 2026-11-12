// A fixed-window request limit per key, kept in memory (per server instance, reset on restart).
// Adapted from mov/lib/rateLimit.ts.

const windows = new Map<string, { count: number; until: number }>();

/** Counts one request for `key`; false once `max` requests were made inside the window. */
export function take(key: string, max: number, windowMs: number, now = Date.now()) {
  const w = windows.get(key);
  if (!w || w.until <= now) {
    windows.set(key, { count: 1, until: now + windowMs });
    // Don't let the table grow without bound
    if (windows.size > 10_000) for (const [k, v] of windows) if (v.until <= now) windows.delete(k);
    return true;
  }
  return ++w.count <= max;
}
