# Plan: a movie recommendation engine with a vector map (new project)

This plan is for a **new, separate project**. It reuses what this repo (`mov`, "A Little Gesture") already does on its films page: fetch films from TMDB, sort them into kinds, score how alike two films are, and draw them as a zoomable map where clicking a film shows its 8 nearest films. The new project turns that into a real recommendation engine. It keeps every film's vector in a vector database, has more kinds of film, and adds a vector UI that shows how films relate to each other.

Everything an AI agent needs to build it is below: the decisions, the files to copy and how to change them, the TMDB endpoints and their quirks, the database schema, the API, the UI, and checks for each phase. Read `plans/orbit-map.md` in this repo too. It is the plan the films page was built from, and this one follows the same shape.

Working name: **reelgraph** (change it freely).

## Primary goal

A visitor opens the app and sees about 2,000 well-known films as dots in **13 coloured clusters**, one per kind of film. Related clusters sit next to each other. Faint threads show the strongest links between films, including links between kinds.

- **Click a film:** it moves to the centre with its 8 nearest films in a ring. Each neighbour shows a % match and the shared reasons ("dir. Hitchcock", "obsession", "1950s"). Clicking a neighbour hops to it.
- **Recommend:** pick 1–5 films you like, and optionally a few you don't. The engine returns 12 films you haven't picked, lights them up on the map, and draws threads back to the picks that led to each one.
- **Search** for any film by title, director or actor, including films not yet in the database. Those are fetched from TMDB, given a vector, and added on the fly.

---

## What this repo already has (copy, don't rewrite)

| In `mov` | What it does | In the new project |
|---|---|---|
| `scripts/tmdb-node.mjs` (+ `.d.mts`) | TMDB client for Node: Bearer token from `TMDB_TOKEN` or `.tmdb-token`, optional `TMDB_DNS` resolver, 8 requests in flight, retries on 429/5xx with backoff, on-disk cache in `.cache/tmdb/` keyed by the sha1 of the URL, tolerates a read-only disk | Copy as is to `lib/tmdb/client.mjs`. |
| `src/orbit/moods.ts` | 7 kinds, each a list of TMDB genre ids with a priority; `moodFor(genreIds)` picks one; Documentary (99) and TV Movie (10770) are excluded | Grow to 13 kinds (table below) as `lib/kinds.ts`. Keep it erasable TypeScript so Node scripts can import it. |
| `scripts/fetch-orbit.mjs` | Builds the dataset: discover pages per kind (sorted by `vote_count.desc`, `vote_count.gte=400`), pinned films, details with `append_to_response=keywords,credits,external_ids`, a Bayesian rating to rank (`m = 3000`), TF-IDF tag vectors, all-pairs cosine, top 8 neighbours, "match %" from percentiles, reasons, a seeded force layout per kind | Split into `scripts/ingest.mjs` (TMDB → database) and `scripts/layout.mjs` (database → map positions). The tag and weight code moves to `lib/vectors.ts`. |
| `src/orbit/similar.ts` | Live lookup for any film: candidates from TMDB recommendations, the director's films, keyword discover and TMDB "similar", ranked by shared tags, plus a small bonus for a place in TMDB's recommendations | Becomes the "film not in the database" path: fetch it, give it a vector, insert it, then use a normal vector query. |
| `src/orbit/layout.ts` | Pure functions: cluster centres on an ellipse (wide screens) or above and below (tall screens), cluster radius, `placeFilms`, `ringLayout` (better matches sit closer) | Copy. Drop the "keep clear of the letter" rect. Centres come from the global layout instead (Phase 4). |
| `src/orbit/orbit.ts` | Canvas 2D map: zoom and pan, hover tooltip, hit-testing, focus ring with % pills and poster thumbnails, trail with back, reduced-motion support, live expansion | The base for `components/map/VectorMap.ts`. Rework it for 2,000+ dots and edges (Phase 6). |
| `src/ui/orbitCard.ts`, `src/movies.ts`, `src/movies.css`, `app/movies/page.tsx` | Film card (poster, meta, overview, 8 neighbours with reasons, IMDb link, TMDB credit), search box, page markup | The card and search come over. The page becomes the app's home. |
| `app/api/orbit/similar/[id]/route.ts` | Next.js route: checks the session, validates the id, caches results in memory, returns 503 without a token | The pattern for every API route. |
| `proxy.ts`, `lib/password.ts`, `lib/session.ts`, `lib/rateLimit.ts`, `app/login/*`, `scripts/hash-password.mjs` | One-password gate: scrypt(password, `APP_PASSWORD_SALT`) compared against `APP_PASSWORD_HASH`, a signed 7-day cookie, 5 wrong tries per 15 minutes | Optional. Copy it if the app should stay private. |
| `scripts/check.mjs` | End-to-end checks with playwright-core and system chromium (`/usr/bin/chromium`) against `next start` | Same harness, new checks. |
| `public/orbit/tmdb.svg` | The approved TMDB logo for the credit line | Copy. |

---

## Key decisions

### 1. Vectors without machine learning (read this first)

The orbit plan's Phase 0 read TMDB's API terms. They forbid using TMDB content "in connection with … a machine learning (ML) or artificial intelligence (AI) based Application", and they forbid making derivatives of it. That is why `mov` has no embeddings, no Transformers.js and no UMAP.

So the vectors here are **made by arithmetic, not by a learned model**:

- **Tag vector (sparse):** TF-IDF over each film's tags, the same tags and weights as `mov`:

  | Tag | Weight | Example label |
  |---|---|---|
  | `k:<keywordId>` | 1.0 | "obsession" |
  | `g:<genreId>` | 0.4 | "thriller" |
  | `d:<directorId>` | 1.5 | "dir. Alfred Hitchcock" |
  | `c:<castId>` (cast `order < 5`) | 0.6 | "James Stewart" |
  | `y:<decade>` | 0.3 | "1950s" |

  Each weight is multiplied by `log(N/df)`. Tags with `df < 2` are dropped, and the vector is L2-normalised. Cosine similarity of two vectors is then their dot product.
- **Kind vector (dense, 13 numbers):** how much the film belongs to each kind. Give 1.0 to its primary kind and 0.5 to every other kind its genres touch, then L2-normalise. It is used for the map layout and for "more like this, but in Horror" filters.

These are ordinary vectors, and a vector database stores and searches them well. **Do not add embeddings, LLM calls, UMAP, t-SNE or SVD over TMDB data.** If the owner later wants learned embeddings, that needs a data source whose licence allows it. That is the owner's decision and is not part of this plan.

Phase 0 must re-read the current TMDB terms (`https://www.themoviedb.org/api-terms-of-use`) and record the date read. If the wording has changed, stop and tell the owner before going on.

### 2. Postgres with pgvector

- `pgvector` supports `sparsevec` with cosine distance (`<=>`) and HNSW indexes. Sparse TF-IDF vectors fit without inventing a dense dimension.
- One database also holds films, tags, kinds, layout positions and the cache of live lookups. No second store is needed.
- **Dev:** `docker run -p 5432:5432 -e POSTGRES_PASSWORD=dev pgvector/pgvector:pg17`.
- **Hosted:** any Postgres with the `vector` extension (Neon, Supabase, RDS). The connection string goes in `DATABASE_URL`.
- **Driver:** `postgres` (porsager) or `pg`. No ORM is needed. The SQL goes in `db/schema.sql` and plain query functions.
- **Limits to confirm in Phase 0, from the pgvector README:**
  - `sparsevec` indices are 1-based in the text format `{i:v,…}/dim`.
  - HNSW on `sparsevec` allows up to 1,000 non-zero elements. A film has well under 100 tags, so this is fine.
  - The opclass is `sparsevec_cosine_ops`.

### 3. The kinds: 13 instead of 7

Each film gets one **primary kind**: the first kind in **priority** order whose genres it has. Drama catches the rest. The **ring order** puts related kinds side by side, so threads between kinds stay short and the ring reads like a colour wheel.

| Ring | Kind (id) | TMDB genre ids | Priority | Colour |
|---|---|---|---|---|
| 1 (top) | Drama (`drama`) | 18 | 13 (fallback) | `#3d5a4a` |
| 2 | Romance (`romance`) | 10749 | 7 | `#b0413e` |
| 3 | Music & Musicals (`music`) | 10402 | 5 | `#a4507a` |
| 4 | Comedy (`comedy`) | 35 | 9 | `#c99a2e` |
| 5 | Family & Animation (`family`) | 10751, 16 | 2 | `#e0a458` |
| 6 | Fantasy (`fantasy`) | 14 | 4 | `#7a5ea8` |
| 7 | Adventure & Western (`adventure`) | 12, 37 | 10 | `#8a6a3b` |
| 8 | Action (`action`) | 28 | 11 | `#c9733a` |
| 9 | Science Fiction (`scifi`) | 878 | 3 | `#3f6f8f` |
| 10 | Horror (`horror`) | 27 | 1 | `#6e2b27` |
| 11 | Thriller (`thriller`) | 53 | 8 | `#4a4f6a` |
| 12 | Crime & Mystery (`crime`) | 80, 9648 | 6 | `#2f3550` |
| 13 | History & War (`history`) | 36, 10752 | 12 | `#6b6b4f` |

- Documentary (99) and TV Movie (10770) stay excluded.
- `kinds.ts` keeps `KINDS`, `EXCLUDED_GENRES` and `kindFor(genreIds)` exactly like `moods.ts`. It adds `kindVector(genreIds): number[]` for the dense 13-number vector.
- `scripts/pins.json` keeps `include` (films that must be in) and `overrides` (TMDB id → kind) when the genre rule gets a film wrong.
- **Target size:** about 150 films per kind, about 2,000 in total. `PER_KIND` is an env setting; the code must also work at 10,000.
- **Check after the first build:** each kind must reach 120 or more. Higher-priority kinds take films away from lower ones, so keep the "page until enough films really land in this kind" loop from `fetch-orbit.mjs`, with a page limit.

Keep the colours distinguishable. Run `npx colorjs.io`, or a small script, to check that every pair of kind colours has a ΔE2000 of at least 12. Adjust the colours rather than the rule.

### 4. Similarity and recommendation, in plain arithmetic

- **Nearest films:** `ORDER BY tag_vec <=> $1 LIMIT 8` on the HNSW index. Then add a re-rank with **exact** cosine plus a small TMDB bonus, as in `similar.ts`: `score = cos + 0.07·(1 - rank/len)` when the film is in TMDB's recommendations for the source film.
- **Match %:** the percentile of the score among all stored top-8 neighbour scores, spread over 55–99, exactly like `fetch-orbit.mjs`. Store the sorted reference scores in a `meta` row so live results use the same scale.
- **Reasons:** the top 3 shared tags by the product of their weights, using their labels. Computed in app code from `film_tags`, not in SQL.
- **Recommend from picks (Rocchio):**
  - `q = normalise(mean(liked vectors) - 0.5·mean(disliked vectors))`, with negative components dropped.
  - Fetch 60 candidates by `<=>`, excluding the picks. Re-rank with **MMR** (λ = 0.7) for variety, and keep 12.
  - For each result, say which liked film it is closest to and why. That is the thread drawn on the map.
- **Optional kind filter:** keep candidates whose primary kind is in the chosen set, or weight them by `kind_vec · chosen`.

All of this is a few lines of TypeScript plus SQL. It doesn't need a recommender library.

### 5. The UI: one zoomable 2D map

- **Global layout, computed offline and stored per film (`x`, `y`):**
  1. Kind centres sit on a ring in ring order. A short force pass moves each centre toward kinds it shares many neighbour edges with, while keeping the ring order.
  2. Inside each kind, the seeded force layout from `fetch-orbit.mjs` runs: `mulberry32(7)`, 300 iterations, springs along within-kind neighbour edges and `k/d²` repulsion. Cluster radius grows with `sqrt(count)`.
  3. Films whose kind vector is spread over two kinds get pulled a little toward the other kind's centre (≤ 25% of the gap). Hybrids then sit on the border, and the map shows the relation.
  - The layout is deterministic: the same data gives the same `x, y`.
- **Rendering:**
  - **Canvas 2D up to about 5,000 dots** (`orbit.ts` already handles 1,400 smoothly).
  - Cull dots outside the view and draw labels by zoom level: kind names always, top films per kind at mid zoom, every title when zoomed in.
  - Edges are drawn only for the hovered or focused film and its neighbours, plus up to 300 strongest cross-kind edges as faint threads.
  - Above 5,000 dots, switch the dot layer to WebGL (`three` `Points` with one draw call). Do not do this before it is needed.
- **Views:**
  - **Field:** all kinds.
  - **Focus ring:** one film and its 8 neighbours. Copy `ringLayout`, the thread width `1 + (match - 55)/12`, the % pills and the poster thumbnails (`w92`, centre `w185`, `crossOrigin='anonymous'`).
  - **Recommend:** the picks glow, the 12 results are ringed in their kind colour, and threads run from each result to the pick that led to it. Everything else dims to 25%.
- **Card:** copy `orbitCard.ts`: poster, title, year · director · ★ rating, overview, 8 neighbours with reasons, IMDb link, TMDB credit. Desktop: right-hand panel, 330 px. Phone: bottom sheet at `max-height: 52vh`.
- **Accessibility:**
  - The `#live` region announces focus changes.
  - Every card button is reachable with Tab.
  - Esc steps back through the trail.
  - `prefers-reduced-motion` turns off drift and animations.
  - Next to the map, a plain list view gives the same results without the canvas.

---

## Project setup (new repo)

- **Stack:** Next.js 16 (App Router, Turbopack), React 19, TypeScript, zod 4, `postgres` (or `pg`), playwright-core (dev). `three` only if the WebGL layer is needed.
- **Next 16 notes:**
  - `proxy.ts` replaces `middleware.ts` and runs on the Node runtime.
  - Read `node_modules/next/dist/docs/` before writing routes. `next dev` writes an `AGENTS.md` block saying so.
  - `next build` runs the project's own `tsc`.
- **Node:** 22.18 or later (`mov` runs Node 26). Scripts import `.ts` files directly through Node's type stripping, so shared files must be **erasable TypeScript**: no enums, no namespaces, no parameter properties.

### Environment variables (`.env.local`, never committed)

```
DATABASE_URL=postgres://postgres:dev@localhost:5432/reelgraph
TMDB_TOKEN=<TMDB API Read Access Token>   # or put the token alone in .tmdb-token
TMDB_DNS=1.1.1.1                          # optional: this network's DNS blocks api.themoviedb.org
PER_KIND=150                              # optional
APP_PASSWORD_SALT=… / APP_PASSWORD_HASH=… # optional, only with the password gate
```

### `.gitignore`

`.next`, `node_modules`, `.cache/`, `.env*`, `.tmdb-token`, `*.tsbuildinfo`, `AGENTS.md`.

### Folder layout

```
app/
  page.tsx                 the map (field view) + search + card
  film/[id]/page.tsx       deep link: opens the map focused on a film
  api/films/search/route.ts         GET ?q=  (database first, then TMDB search)
  api/films/[id]/route.ts           GET one film (fetched live and added if missing)
  api/films/[id]/similar/route.ts   GET 8 nearest with match % and reasons
  api/recommend/route.ts            POST { like: number[], dislike?: number[], kinds?: string[] }
  api/map/route.ts                  GET kinds + films (id, kind, x, y, pop, title, year, poster)
  api/map/edges/route.ts            GET strongest cross-kind edges (cached)
components/map/            VectorMap.ts (canvas), layout.ts, FilmCard.ts, Search.ts
lib/
  kinds.ts                 13 kinds, kindFor, kindVector (erasable TS)
  vectors.ts               tags, tfidf, cosine, reasons, match %, Rocchio, MMR (erasable TS)
  tmdb/client.mjs          copied from mov scripts/tmdb-node.mjs
  tmdb/live.ts             fetch an unknown film, give it a vector, insert it (from mov similar.ts)
  db.ts                    connection + query helpers
db/schema.sql
scripts/
  ingest.mjs               TMDB → films, tags, vectors   (npm run ingest)
  layout.mjs               neighbours → x,y per film     (npm run layout)
  check.mjs                end-to-end checks             (npm run check)
  pins.json
```

### npm scripts

`dev`, `build`, `start`, `db:init` (runs `db/schema.sql`), `ingest`, `layout`, `check` (`npm run build && node scripts/check.mjs`).

---

## TMDB: endpoints, fields and quirks

**Auth:** the header `Authorization: Bearer <API Read Access Token>`. Never use `api_key=` in code, and never call TMDB from the browser.

| Endpoint | Used for | Notes |
|---|---|---|
| `GET /3/discover/movie` | candidates per kind | `with_genres` (`\|` = OR), `without_genres=99\|10770`, `sort_by=vote_count.desc`, `vote_count.gte=400`, `include_adult=false`, `language=en-US`, `page` 1–500, 20 results per page |
| `GET /3/movie/{id}?append_to_response=keywords,credits,external_ids,recommendations,similar` | details + the TMDB bonus | Keywords are at `keywords.keywords` (accept `keywords.results` too). Directors are `credits.crew[job === "Director"]`. Top cast is `credits.cast[order < 5]`. The IMDb id is `imdb_id` or `external_ids.imdb_id`. |
| `GET /3/search/movie?query=&year=` | search, pins | Take `results[0]` for pins. Search shows up to 10 results. |
| `GET /3/find/{imdb_id}?external_source=imdb_id` | IMDb id → TMDB id | `movie_results[]` |
| Images | posters | `https://image.tmdb.org/t/p/{w92\|w185\|w342}{poster_path}`. The server sends `access-control-allow-origin: *`, so canvas drawing needs `crossOrigin='anonymous'`. |

**Quirks (all learned while building `mov`):**
- **DNS:** this network's DNS blocks `api.themoviedb.org`; images are fine. Fix it with `TMDB_DNS=1.1.1.1`, which goes through the client's custom `lookup`. `dns.setServers()` doesn't change what `fetch` resolves, so the client uses `node:https` with `lookup`.
- **Rate limit:** about 40 requests per second. Keep 8 in flight and back off on 429 using `retry-after`.
- **Thin recommendations:** TMDB's recommendations can be thin (Vertigo gets no other Hitchcock). That's why `similar.ts` mixes in the director's films and a keyword discover. Keep that mix for the live path.
- **Lost films:** Drama and Action lose many discover results to higher-priority kinds. Keep paging until enough films really land in each kind.
- **Licence housekeeping:**
  - Show the TMDB logo and "This product uses the TMDB API but is not endorsed or certified by TMDB." in the card and on an About page.
  - Cached TMDB data must not be older than 6 months. Store `fetched_at` per film. `npm run check` warns at 150 days, and `npm run ingest -- --refresh` re-fetches anything older.

---

## Database schema (`db/schema.sql`)

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE kinds (
  id text PRIMARY KEY, name text NOT NULL, color text NOT NULL,
  ring smallint NOT NULL, priority smallint NOT NULL, genres int[] NOT NULL,
  cx real, cy real, radius real                  -- written by npm run layout
);

CREATE TABLE films (
  id int PRIMARY KEY,                            -- TMDB id
  imdb text, title text NOT NULL, year smallint NOT NULL,
  kind text NOT NULL REFERENCES kinds(id),
  poster text NOT NULL, overview text NOT NULL,
  rating real NOT NULL, votes int NOT NULL, pop real NOT NULL,   -- pop: 0..1 from log votes
  director text, cast_names text[] NOT NULL DEFAULT '{}',
  genres int[] NOT NULL,
  tag_vec sparsevec,                             -- dimension = row count of tags, set by ingest
  kind_vec vector(13) NOT NULL,
  x real, y real,                                -- map position, written by npm run layout
  tmdb_recs int[] NOT NULL DEFAULT '{}',         -- TMDB recommendation ids, in order
  source text NOT NULL DEFAULT 'ingest',         -- 'ingest' | 'live'
  fetched_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tags (
  dim int PRIMARY KEY,                           -- 1-based sparsevec index
  key text UNIQUE NOT NULL,                      -- 'k:9748', 'd:2636', 'y:1950'
  label text NOT NULL, base_weight real NOT NULL, df int NOT NULL DEFAULT 0
);

CREATE TABLE film_tags (
  film_id int REFERENCES films(id) ON DELETE CASCADE,
  dim int REFERENCES tags(dim),
  weight real NOT NULL,                          -- tf-idf weight after normalising
  PRIMARY KEY (film_id, dim)
);

CREATE TABLE neighbours (                        -- top 8 per film, for the map threads and match scale
  film_id int REFERENCES films(id) ON DELETE CASCADE,
  rank smallint, other_id int REFERENCES films(id) ON DELETE CASCADE,
  score real NOT NULL, match smallint NOT NULL, reasons text[] NOT NULL,
  PRIMARY KEY (film_id, rank)
);

CREATE TABLE meta (key text PRIMARY KEY, value jsonb NOT NULL);  -- 'match_scale', 'built_at', 'n'

CREATE INDEX films_tag_hnsw ON films USING hnsw (tag_vec sparsevec_cosine_ops);
CREATE INDEX films_kind ON films (kind);
CREATE INDEX films_title_trgm ON films USING gin (title gin_trgm_ops);   -- needs pg_trgm
```

- **The `sparsevec` dimension** is fixed when vectors are written: the text format is `{dim:value,…}/total_dims`. Use the tag table's row count at ingest time plus room to grow (e.g. ×2), and record it in `meta`. Live films may only use existing tags. A new keyword is skipped for the vector but kept as a label.
- **IDF for live films** uses the stored `df` and `N`, so live vectors are on the same scale. `df` is not updated live; it is recomputed on the next full ingest.

---

## Phase 0: Documentation discovery

**Goal:** check every API, limit and rule this plan depends on before writing code.

- [ ] Read the current TMDB terms. Confirm the ML/AI clause, the attribution requirement and the 6-month cache rule, and write the date read and the quotes into `docs/decisions.md`. If they changed, stop and ask the owner.
- [ ] Read the TMDB reference for the endpoints in the table, as `.md` from developer.themoviedb.org, and confirm the field names.
- [ ] Read the pgvector README: confirm the `sparsevec` text format, max dimensions, the HNSW limit on non-zero elements, `sparsevec_cosine_ops` and the `<=>` operator, then note the version.
- [ ] Read `node_modules/next/dist/docs/` for route handlers, `proxy.ts` and `cookies()` in this Next version.
- [ ] Copy the files listed in "What this repo already has" and get the copied TMDB client working with a single `/movie/603` call.

**Anti-patterns:** don't invent TMDB parameters, don't assume pgvector limits from memory, and don't use `middleware.ts`.

## Phase 1: Database and ingest (`npm run db:init`, `npm run ingest`)

**Goal:** about 2,000 films in Postgres, each with a tag vector, a kind vector and its tags.

1. Write `db/schema.sql` and `db:init`. Insert the 13 `KINDS` rows.
2. Port the candidate loop, pins, details fetch and Bayesian ranking from `fetch-orbit.mjs` into `scripts/ingest.mjs`, using `kindFor`, `PER_KIND` and the 13 kinds.
3. Build tags with the weights in Decision 1. Upsert the `tags` rows, compute `df` over the chosen films, and drop tags with `df < 2` from the vectors (keep them in `tags`).
4. Compute L2-normalised TF-IDF weights. Write `film_tags` and `films.tag_vec` (as `'{d:w,…}/DIM'`) and `kind_vec`.
5. Compute the top 8 neighbours for every film. Use the database (`<=>` with `LIMIT 9`, then drop self) and re-rank with exact cosine plus the TMDB bonus. Write `neighbours` with reasons. Store the sorted scores as `meta.match_scale` and fill in `match`.
6. Make it idempotent: run it in a transaction per batch, upsert by id, and give the same output from a warm cache.

**Checks:**
- [ ] `SELECT kind, count(*) FROM films GROUP BY kind` shows 13 kinds with ≥ 120 each.
- [ ] Vertigo's neighbours include at least 2 Hitchcock or obsession/thriller films. The Godfather's include The Godfather Part II.
- [ ] HNSW top 8 and brute-force top 8 agree on ≥ 95% of 100 random films (check with `SET hnsw.ef_search = 100` and an exact query).
- [ ] A second run with a warm cache changes no rows (compare `md5` of an ordered dump).
- [ ] `grep -rE "transformers|umap|openai|embedding|api_key=" lib scripts app` is empty.

## Phase 2: Layout (`npm run layout`)

**Goal:** a stable `x, y` for every film and a centre and radius for every kind (Decision 5).

- Pure functions in `lib/layoutForce.ts` (erasable TS), tested by `scripts/layout-test.mjs` in Node:
  - **Kind centres:** a ring, then a pull along cross-kind neighbour counts, keeping the ring order.
  - **Inside each kind:** the seeded force layout from `fetch-orbit.mjs`, with radius ∝ `sqrt(count)`.
  - **Hybrids:** the pull toward a second kind.
- Write `kinds.cx, cy, radius` and `films.x, y`, in map units with the whole map in [-1, 1]².

**Checks:**
- [ ] Deterministic: two runs give identical numbers.
- [ ] No two kind discs overlap by more than 10% of the smaller radius.
- [ ] ≥ 90% of films sit inside their own kind's disc.
- [ ] Neighbouring kinds in ring order share more cross-edges than kinds opposite each other (a sanity check that the ring order is sensible).

## Phase 3: API routes

**Goal:** everything the UI needs, behind zod-validated inputs.

| Route | Returns | Notes |
|---|---|---|
| `GET /api/map` | `{ builtAt, kinds[], films[] }`, with films as compact arrays `[id, kindIdx, x, y, pop, title, year, poster]` | about 150 KB gzipped at 2,000 films. `Cache-Control: public, max-age=3600` (or `private` behind the gate). |
| `GET /api/map/edges` | the 300 strongest cross-kind neighbour edges `[a, b, match]` | Precomputed by `layout`, stored in `meta`. |
| `GET /api/films/[id]/similar` | `{ film, nb: [{ film, match, reasons }] }` (the same shape as `mov`'s `LiveResult`) | Reads `neighbours`. If the film is missing, go to `lib/tmdb/live.ts` and **insert it** (`source='live'`, with an `x, y` placed in its kind disc next to its best neighbour). Returns 503 without a token. |
| `GET /api/films/search?q=` | up to 10 results | Trigram over titles plus `director`/`cast_names`. If fewer than 3 hits, add TMDB `/search/movie` results marked `inMap:false`. |
| `POST /api/recommend` | `{ results: [{ film, match, from: likedId, reasons }] }` | The body is `{ like: 1–5 ids, dislike?: ≤ 5 ids, kinds?: string[] }`. Rocchio, then 60 candidates, MMR, 12 results. |

- Validate the ids with `^\d{1,9}$`. Return 404 for unknown films, 502 for TMDB errors, and never leak the token.
- Keep an in-memory map of in-flight live lookups (as in `mov`'s route), so one film is never fetched twice at once.
- If the password gate is used, every route re-checks the session, as `mov`'s similar route does.

**Checks:** route tests in `scripts/check.mjs` use `fetch` against `next start`: the shapes are zod-valid, a recommend with `[Vertigo]` returns 12 films not including Vertigo, and an unknown id is inserted and then served from the database the second time.

## Phase 4: The vector map UI

**Goal:** the field, focus ring, card, search and recommend views from Decision 5.

1. `app/page.tsx` renders fixed markup (canvas, search, card, recommend tray, live region) and a client `Boot` component that imports `components/map/main.ts` in `useEffect`. This is the same pattern as `mov`'s `app/Boot.tsx`, because the map is imperative canvas code, not React state.
2. `VectorMap.ts`: start from `orbit.ts`.
   - Map units → screen through a view transform. Zoom with the wheel or pinch about the cursor, and pan with drag. `fit()` shows everything.
   - Hit-test with a uniform grid over the dots, rebuilt on zoom.
   - Draw layers in order: kind clouds → faint cross-kind threads → dots (radius `2 + pop·3.5`) → labels by zoom → hover → focus ring.
   - Loop only while something animates, and draw once with reduced motion.
3. The focus ring and trail come from `orbit.ts` (`focus`, `back`, `clear`, live expansion) with the card copied from `orbitCard.ts`.
4. **Recommend tray:** "Like" and "Not for me" buttons on the card add films as chips. "Recommend" calls the API and switches to the recommend view. The results list mirrors the map for keyboard and screen-reader users.
5. **Deep link:** `/film/[id]` opens the map focused on that film. The URL updates with `history.replaceState` while hopping.
6. **Mobile:** the kinds stack two per row in tall layouts (from `layout.ts`), and the card becomes a bottom sheet with the ring in the top 60%.

**Checks:**
- [ ] 13 labelled clusters, with 60 fps panning at 2,000 dots on a mid-range laptop (Performance panel, no frames over 16 ms during a pan).
- [ ] Clicking a dot gives a ring of 8 with % pills and the card with reasons. Hopping grows the trail, and Esc steps back.
- [ ] Recommending from 3 liked films highlights 12 results with threads back to the picks.
- [ ] Searching for a film not in the map adds it live and focuses it.
- [ ] Reduced motion: nothing drifts.

## Phase 5: Checks, screenshots and docs

- **`scripts/check.mjs`:**
  - Same harness as `mov`: `next start` on port 4317 and playwright-core with `/usr/bin/chromium`, at 1440×900 and 390×844.
  - A test hook on `window.__rg`: `count`, `focused`, `trail`, `screenOf(id)` and `emptyPoint()`.
  - Stub TMDB in checks (`page.route` for the live route), so CI doesn't need a token.
- **Data-age warning** at 150 days, and the grep guard from Phase 1.
- **Screenshots:** `docs/map.png`, `docs/focus.png`, `docs/recommend.png` and `docs/phone.png`.
- **README:** setup (Docker pgvector, `.env.local`, `db:init` → `ingest` → `layout` → `dev`), the 13 kinds, how similarity works (and why there's no ML), the TMDB credit and the 6-month refresh rule.

## Not now

- User accounts and saved taste profiles. Picks live in the URL and `localStorage` only.
- Learned embeddings or LLM summaries (see Decision 1).
- TV shows.
- Ratings imported from Letterboxd or IMDb.
- A 3D map. Stay 2D unless the owner asks.

## Rules for the agent building this

- Commits: short, simple messages that say what changed, with **no** `Co-Authored-By` or other attribution line. Keep `AGENTS.md` git-ignored.
- Never commit `.env*`, `.tmdb-token` or `.cache/`.
- Never print or store the owner's real password; only the salt and hash go in the env.
- Shared files used by both Node scripts and the app must be erasable TypeScript.
- Prefer copying the `mov` file named in this plan over writing a new version. Note in the file header where it came from.
