// Copied from mov/scripts/tmdb-node.mjs.
// TMDB API client for Node, used by scripts/build-data.mjs. Caches every response in .cache/tmdb/
// (when the disk is writable), retries 429s and 5xx, and keeps at most 8 requests in flight.
//
//   TMDB_TOKEN=<API Read Access Token>   (or put the token alone in .tmdb-token)
//   TMDB_DNS=1.1.1.1   (optional) resolve api.themoviedb.org through this DNS server
import { createHash } from 'node:crypto';
import { promises as dnsp } from 'node:dns';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { join } from 'node:path';

export const NO_TOKEN = 'Set TMDB_TOKEN, or save it in .tmdb-token: your TMDB API Read Access Token (themoviedb.org → Settings → API).';

export function readToken(root) {
  const file = join(root, '.tmdb-token');
  return process.env.TMDB_TOKEN || (existsSync(file) ? readFileSync(file, 'utf8').trim() : '');
}

export function tmdbClient({ root, token = readToken(root), dns = process.env.TMDB_DNS, onFetch = () => {} }) {
  const cacheDir = join(root, '.cache', 'tmdb');

  let resolver = null;
  if (dns) {
    resolver = new dnsp.Resolver();
    resolver.setServers([dns]);
  }
  const lookup = resolver
    ? (host, opts, cb) =>
        resolver.resolve4(host).then(
          a => (opts.all ? cb(null, a.map(address => ({ address, family: 4 }))) : cb(null, a[0], 4)),
          cb,
        )
    : undefined;

  const getRaw = url =>
    new Promise((resolve, reject) => {
      const req = request(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, lookup, timeout: 20000 }, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', c => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      });
      req.on('timeout', () => req.destroy(new Error('timed out')));
      req.on('error', reject);
      req.end();
    });

  let active = 0;
  const queue = [];
  const limit = fn =>
    new Promise((resolve, reject) => {
      const run = () => {
        active++;
        fn().then(resolve, reject).finally(() => {
          active--;
          queue.shift()?.();
        });
      };
      active < 8 ? run() : queue.push(run);
    });

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function get(path, params = {}) {
    const qs = new URLSearchParams(Object.entries(params).sort(([a], [b]) => a.localeCompare(b))).toString();
    const url = `https://api.themoviedb.org/3${path}${qs ? `?${qs}` : ''}`;
    const file = join(cacheDir, createHash('sha1').update(url).digest('hex') + '.json');
    if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
    if (!token) throw new Error(NO_TOKEN);
    return limit(async () => {
      for (let attempt = 0; ; attempt++) {
        let res;
        try {
          res = await getRaw(url);
        } catch (e) {
          if (attempt >= 4) throw new Error(`${path}: ${e.message}${resolver ? '' : ' (try TMDB_DNS=1.1.1.1)'}`);
          await sleep(500 * 2 ** attempt);
          continue;
        }
        if (res.status === 200) {
          try {
            mkdirSync(cacheDir, { recursive: true });
            writeFileSync(file, res.body);
          } catch {} // read-only disk (e.g. serverless hosting): just don't cache
          onFetch();
          return JSON.parse(res.body);
        }
        if ((res.status === 429 || res.status >= 500) && attempt < 5) {
          await sleep((Number(res.headers['retry-after']) || 0) * 1000 || 500 * 2 ** attempt);
          continue;
        }
        const err = new Error(`${path}: HTTP ${res.status} ${res.body.slice(0, 200)}`);
        err.status = res.status;
        throw err;
      }
    });
  }

  return { get, hasToken: Boolean(token) };
}
