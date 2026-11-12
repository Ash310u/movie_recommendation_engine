# Plan: the "galaxy" vector map UI (addendum to `movie-recommendation-engine.md`)

Inspiration: **https://mikeyguinness.com/movies/** ("Movie Vector Map"), read on 2026-11-12.

This plan **replaces Decision 5 and Phase 4** of `plans/movie-recommendation-engine.md` with a UI modelled on that site. Everything else in the engine plan stays: TMDB ingest, pgvector, TF-IDF vectors, Rocchio and MMR, and the API routes. A few small additions to the schema, ingest and API are listed below.

Mockup: `plans/mockups/vector-map.png` (source: `plans/mockups/vector-map.html`).

---

## What the reference site does (observed)

| Aspect | Reference site | Notes |
|---|---|---|
| Scale | 36,933 films, ~66 clusters (many unnamed), ~15.9k "noise" points (`cluster: -1`) | Noise points and `x,y` in [0,1000]² point to text embeddings + UMAP + HDBSCAN. |
| Data | One static `movie_points.json` (31 MB) + `cluster_labels.json` | Each film has id, title, year, language, overview, genres, keywords, cast, director, poster, rating, popularity, x, y, cluster, color and `similar[20]`. |
| Canvas | Full-screen 2D canvas on `#0a0b0f`. Tiny dots (base radius 1.4 px), sized `0.7 + log1p(pop)/max·1.7`. Each film has its own colour, so hues shade gradually across the map. | Thins out dots (`i % skip`) when zoomed out. |
| Labels | Cluster names at cluster centroids. Font size 11–21 px grows with cluster size. **L** toggles them. | |
| Top-left controls (280 px) | Search for **films, genres and keywords**, each result tagged `FILM` / `GENRE` / `KEYWORD`. A pick becomes a highlight chip. An **Any (OR) / All (AND)** toggle, a collapsible **Languages** filter with counts and All/None, and a counter ("36,933 films · 412 highlighted"). | When the detail panel opens, the controls slide right by 346 px. |
| Highlighting | Films that don't match the chips are hidden, and the matching films stay. | |
| Click a film | **Left panel** (340 px): 2:3 poster, title, year · language, clickable genre/keyword chips (each adds a highlight), Overview. **Right panel** (330 px): "Similar films" rows with a colour dot, title and year. On the map, lines run to its similar films, which get larger dots. | Panels slide in over 0.22 s. |
| Hover | A tooltip with the title, then year · language · genres underneath. | |
| Hint | Bottom left: "Scroll to zoom · Drag to pan · Click a film for details · Select genres/keywords to highlight · Press L to toggle labels". | |
| Mobile | Detail panel is the top 35 %, similar list the bottom 25 %, and the poster is hidden. | |

### What we take, what we change, and why

- **Take:** the dark full-screen canvas, the tiny popularity-sized dots, the per-film colour, the cluster labels, the search with typed results that turns picks into highlight chips with AND/OR, the language filter, the counter, left detail and right similar panels, the hover tooltip, the hint line and the **L** key.
- **Change: the layout has no embeddings and no UMAP.** Engine-plan Decision 1 still holds, because TMDB's terms forbid ML/AI use of their data. The "galaxy" look comes from the force layout (engine Decision 5), plus **sub-clusters** (below) that supply the many small named islands.
- **Change: dim, don't hide.** Films that don't match the highlight chips drop to 10 % alpha, so the shape of the map stays readable.
- **Add (what the reference doesn't have):**
  - **Match %** and **reasons** in the similar list.
  - **Like / Not for me** buttons and a **Recommend** tray (engine Decision 4).
  - **Live add** for films that aren't in the map yet.
  - A **kind legend** that doubles as a filter.

---

## Data additions

### Schema (`db/schema.sql`)

```sql
ALTER TABLE films ADD COLUMN language text NOT NULL DEFAULT 'en';    -- TMDB original_language
ALTER TABLE films ADD COLUMN sub smallint;                           -- sub-cluster index within its kind (written by layout)
ALTER TABLE films ADD COLUMN color text;                             -- per-film hex, written by layout

CREATE TABLE subclusters (
  kind text REFERENCES kinds(id), sub smallint,
  name text NOT NULL, cx real NOT NULL, cy real NOT NULL, size int NOT NULL,
  PRIMARY KEY (kind, sub)
);
```

### Ingest (`scripts/ingest.mjs`)

- Store `original_language` as `films.language`.
- **Optional non-English passes, so the language filter means something:** for each of `fr, ja, ko, es, it, de, hi, zh`, run the discover loop with `with_original_language=<code>` and `vote_count.gte=150`. Cap each language at `PER_LANG` (default 60). Pins still win.
- Target about 2,500 films at the defaults. The `PER_KIND` / `PER_LANG` settings must also work at 10,000 (WebGL above 5k, per the engine plan).

### Layout (`scripts/layout.mjs`), new steps after the engine's Phase 2

1. **Sub-clusters, without ML:** within each kind, run seeded **label propagation** on the top-8 neighbour graph, with edges weighted by score, `mulberry32(11)` and 30 rounds. Merge communities smaller than 8 into their best-connected neighbour. Expect 3–7 subs per kind, about 60 in total, close to the reference's ~66.
2. **Sub-cluster names:** take the top 2 tags by `Σ weight in sub / Σ weight in kind` (the most distinctive tags), using their labels. Prefer keyword and director tags. Examples: "Neo-Noir · Heist", "Hitchcock · Obsession", "Space Opera". Then pull each sub a little toward its own centroid inside the kind disc, so it reads as an island.
3. **Per-film colour:**
   - Start from the kind's colour (the dark-theme palette below).
   - Mix in up to 35 % of the second-strongest kind's colour, weighted by `kind_vec`, in OKLab. Hybrids then show their mixed character, the way the reference shades between clusters.
   - Nudge the lightness by ±6 % per sub, so neighbouring subs stay apart.
4. Write `films.sub`, `films.color` and the `subclusters` rows.

**Checks:**

- [ ] Deterministic: two runs give identical subs, names and colours.
- [ ] 40–80 subs in total.
- [ ] No name is empty or appears twice.
- [ ] Vertigo's sub name mentions Hitchcock or obsession.

### Dark-theme kind palette (replaces the engine plan's colours, which vanish on `#0a0b0f`)

| Kind | Colour | Kind | Colour |
|---|---|---|---|
| Drama | `#6fbf8e` | Action | `#ff8a4c` |
| Romance | `#ff7a9a` | Science Fiction | `#4fb6f0` |
| Music & Musicals | `#d77be0` | Horror | `#d2433f` |
| Comedy | `#f2c14e` | Thriller | `#9aa3d9` |
| Family & Animation | `#ffb067` | Crime & Mystery | `#5c7cfa` |
| Fantasy | `#a98bf0` | History & War | `#b9b27a` |
| Adventure & Western | `#c9a26b` | | |

Keep the engine plan's rule, now measured against `#0a0b0f`: every pair needs ΔE2000 ≥ 12, and every colour needs a contrast of ≥ 4.5:1 against the background. Adjust the colours, not the rule.

### API changes

- `GET /api/map` adds `language`, `sub` and `color` to each film's compact array. It also returns `subclusters[]` and `languages[{code, count}]`.
- `GET /api/map/tags`: loaded after first paint, so it isn't on the critical path. Returns `{ vocab: { genres[], keywords[{id,label,df}] }, filmTags: { [filmId]: number[] } }`, with keyword dims only for keywords that have `df ≥ 3`. It powers client-side AND/OR highlighting with no round trips. Expect about 120 KB gzipped at 2.5k films.
- `GET /api/films/search?q=` returns typed results: `{type:'film'|'genre'|'keyword'|'director'|'kind', …}`. Films come first, then genres and kinds, then keywords and directors, 12 results at most.

---

## Phase 4 (replaces the engine plan's Phase 4): the galaxy UI

Follow the same pattern as the engine plan: `app/page.tsx` renders fixed markup, and a client `Boot` imports `components/map/main.ts` in `useEffect`. The map is imperative canvas code.

### 4.1 Design tokens (`components/map/map.css`)

```css
:root {
  --bg:#0a0b0f; --panel:#14161d; --panel-line:#232733; --hover:#2c3140;
  --text:#e7e9ee; --muted:#8b90a0; --body:#cfd3dd; --accent:#5b8cff;
  --tag-film-bg:#263056; --tag-film:#a9bcff;
  --tag-genre-bg:#2c4a34; --tag-genre:#9be0af;
  --tag-kw-bg:#4a3a26;   --tag-kw:#e6c79b;
  --like:#3fbf7f; --dislike:#e5484d;
}
font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
```

Floating boxes use `rgba(20,22,29,0.95)`, a 1 px `--panel-line` border and an 8 px radius. Panels slide in with `transform 0.22s ease`.

### 4.2 Canvas (`components/map/VectorMap.ts`)

**Layers, in draw order:**

1. Background.
2. *(optional)* A very faint radial "nebula" per kind: a 6 % alpha gradient over the kind disc.
3. Cross-kind threads, at most 300, with alpha 0.05.
4. Dots.
5. Labels.
6. Selection lines and neighbour dots.
7. Hover ring.

**Dots:**

- Radius `BASE·sizeMul`, where `BASE = 1.6 · clamp(zoom^0.5, 1, 4)` and `sizeMul = 0.7 + log1p(votes)/maxLog·1.7`, as in the reference.
- With 2.5k films there's no need to thin dots out. Keep the reference's `i % skip` thinning only above 20k.
- Use one `fillStyle` batch per colour bucket. Quantise the per-film colours to about 64 buckets at load, so a frame makes about 64 `fill()` calls instead of 2,500.

**Labels**, drawn with `text-shadow`-style stroking: draw with `strokeStyle` `#0a0b0f` at 3 px, then fill.

| Zoom | Labels |
|---|---|
| < 1.5 | Kind names only: 13–20 px, weight 600, in the kind colour. |
| 1.5–4 | Sub-cluster names: 10–14 px, `--text` at 0.8 alpha. Kind names fade out. |
| > 4 | Film titles for dots on screen, popularity-first, with a collision grid of 1 label per 80×18 px cell. |

The **L** key toggles every label.

**Selection:**

- 1 px lines from the selected film to its 8 neighbours, `rgba(255,255,255,0.35)`. The line width follows the engine plan: `1 + (match-55)/12`.
- The neighbours get 1.8× dots with a white 1.5 px ring.
- The selected film gets a 2.4× dot and a pulsing halo, which is static under reduced motion.

**Highlight:** a film's alpha is 1 if it matches the chips (OR: any chip; AND: all chips) and 0.1 otherwise. The language filter *hides* films, as the reference does, and the counter reflects both.

**Hit-test:** a uniform grid, with the reference's `dist² / sizeMul²` preference for bigger dots and an 8 px hover tolerance.

**Input:**

- The wheel zooms about the cursor.
- Drag pans, and so do pinch and two-finger pan on touch.
- A click without movement (< 4 px) selects.
- Esc closes the panels, then steps back through the trail.
- `fit()` on load and on double-click on empty space.

**Optional:** keep the engine plan's **focus ring** view (ring layout around a film) behind `F`, or "Show as ring" in the card. The default click behaviour copies the reference: the film stays where it is and lines go out to its neighbours.

### 4.3 Controls, top left (`components/map/Controls.ts`)

The controls column is 280 px, at `left:14px; top:12px`.

1. **Search** (`Search films, genres, keywords, directors…`), with typed results:
   - Tags are `FILM` (blue), `GENRE`/`KIND` (green), `KEYWORD`/`DIRECTOR` (amber).
   - Film results show the year on the right. A result that only matched on cast or director shows that match in italics ("via James Stewart").
   - Films not in the map get a `+ ADD` badge. Choosing one calls the live route, inserts the film and focuses it.
   - Arrow keys and Enter work. `/` focuses the box.
2. **Highlight chips:** genre/kind chips have a green inset border, and keyword/director chips have an amber one. Each has a `×`.
3. **Match: Any (OR) | All (AND)**, a segmented control that only shows while chips exist.
4. **Languages** box: collapsed by default, with All/None, checkboxes and counts.
5. **Kinds** box (new): 13 rows, each with a colour swatch, name and count. Clicking a row toggles the kind as a highlight chip, and hovering a row pulses that kind on the map.
6. **Counter:** "2,513 films · 184 highlighted".

When the detail panel opens, the column slides right by 346 px (`#controls.shifted`).

### 4.4 Detail panel, left (`components/map/FilmCard.ts`, from the engine plan's card)

The panel is 340 px.

- **Poster:** `w342` at 2:3, with a `×` close button on it.
- **Title:** 19 px, weight 600.
- **Meta line:** year · language · dir. Director · ★ rating.
- **Chips:** genre and keyword chips. Clicking one adds a highlight.
- **Overview:** 13.5 px, line-height 1.6, `--body`.
- **Actions:**
  - **♥ Like** and **✕ Not for me** toggle buttons, which add the film to the recommend tray.
  - IMDb link.
  - "Show as ring".
- **Footer:** the TMDB logo and the required credit line.

### 4.5 Similar panel, right (330 px)

- The title is "Similar films", in uppercase with 0.06em letter spacing, `--muted`.
- There are 8 rows, each laid out as: kind-colour dot · title · year (muted) · **match %** pill. Under each sits a reasons line, 11 px, muted: "dir. Hitchcock · obsession · 1950s".
- Hovering a row highlights that neighbour's dot and line on the map. Clicking hops to it, so the trail grows and the URL updates with `replaceState`.

### 4.6 Recommend tray, bottom centre (new)

- **Hidden until there is a pick.** After that it is a floating pill, `rgba(20,22,29,0.95)`, holding:
  - "Your picks"
  - liked chips (green border) and disliked chips (red border, struck through)
  - a **Recommend 12 →** button in `--accent`
- **Results:** the 12 films get a ring in their kind colour and the picks glow. Threads run from each result to the pick that led to it, and everything else dims to 25 %. The right panel turns into "Recommended for you" rows with "because you liked *Vertigo*".
- **Storage:** the picks persist in `localStorage` and `?like=…&dislike=…`.

### 4.7 Hover tooltip and hint line

- **Tooltip:** max width 260 px. The title in weight 600, then "1958 · English · Mystery, Romance, Thriller", and the kind and sub-cluster underneath in the kind colour.
- **Hint line,** bottom left, muted, 11.5 px: "Scroll to zoom · Drag to pan · Click a film · ♥ films to get recommendations · L labels · / search". It is hidden on mobile.

### 4.8 Mobile (≤ 640 px)

The layout follows the reference:

- The detail panel is the top 35 %, without the poster.
- The similar panel is the bottom 25 %.
- The controls are full width minus 28 px and don't shift.
- The recommend tray sits above the similar panel.

### 4.9 Loading

- A centred "Loading movie map…" over a 240×4 px bar with a sliding `--accent` segment.
- `/api/map` paints first, and `/api/map/tags` loads in the background. Search for genres and keywords is disabled until it arrives, with the placeholder "Loading tags…".

### Checks (replace the engine plan's Phase 4 checks)

- [ ] On first paint at 1440×900, 13 kind labels are visible, and zooming to 2× shows sub-cluster labels.
- [ ] Panning at 2.5k dots runs at 60 fps: no frames over 16 ms in the Performance panel.
- [ ] Searching "obsession" and choosing the KEYWORD result adds a chip. The counter shows the highlighted count, and the films that don't match are dimmed.
- [ ] Adding a GENRE chip and switching to AND shrinks the highlighted count.
- [ ] Clicking Vertigo opens the left panel (poster, meta, chips) and the right panel (8 rows with % and reasons), draws 8 lines and shifts the controls.
- [ ] With ♥ on 3 films, Recommend lights up 12 results with threads back to the picks.
- [ ] Pressing **L** hides every label.
- [ ] Esc closes the panels.
- [ ] Mobile (390×844): the panels sit at the top and bottom, and nothing overlaps the search.
- [ ] Reduced motion: no pulsing halo and no animated transitions.
- [ ] `docs/map.png`, `docs/focus.png`, `docs/recommend.png` and `docs/phone.png` are regenerated.

## Order of work

1. Data additions: schema, ingest language, layout sub-clusters and colours. Then `npm run layout` and the checks.
2. API: map fields, `/api/map/tags`, typed search.
3. The canvas with dots, labels, zoom and pan, and hover (4.1, 4.2).
4. Controls, search and highlighting (4.3).
5. The detail and similar panels (4.4, 4.5).
6. The recommend tray (4.6).
7. Mobile, loading, accessibility and checks (4.7–4.9).
