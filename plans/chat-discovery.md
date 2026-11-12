# Plan: chat discovery on the map

Status: phases 1–4 implemented 2026-11-13 (see README "Chat"); phase 5 not started. Replaces `plans/intelligent-search.md`, whose cut-scenes example was only an example.

Mockup: `plans/mockups/chat.png` (source: `plans/mockups/chat.html`). It uses the real map positions; the chat text is illustrative.

## What the visitor gets

1. A **chat box sits at the bottom centre** of the map. The normal search stays at the top left as it is.
2. The visitor types anything:
   - "I want to watch a movie where a rich lifestyle is shown"
   - "something like Parasite but funnier"
   - "a 90s crime thriller, not too long"
   - "what should I watch tonight, I liked Interstellar"
3. The assistant answers in a few sentences and names films. Each film in the reply is a **numbered chip**.
4. Those films **glow on the map**: a gold halo, a numbered badge and the title, with every other film dimmed to 22%. The map zooms to fit them.
5. The **right panel switches to "From chat"**: number, poster, title, year, and one line on why it fits ("Lavish 1920s Long Island parties and old-money excess"), plus where that came from.
6. The visitor keeps talking ("only comedies", "darker", "more like #2", "not before 2000"). The glow and the panel update with every answer.
7. Clicking a chip, a row or a glowing dot opens the normal film card on the left. The chat results stay lit.

---

# Part 1: the UI

The existing pieces it builds on are `components/map/main.ts`, `VectorMap.ts` and `map.css`.

## 1.1 Chat dock, bottom centre (`components/map/Chat.ts`)

The dock is about 640 px wide and is centred in the space between the panels.

**Collapsed:** one input pill.
- Placeholder: "Ask for a film… e.g. *a movie where a rich lifestyle is shown*".
- **Enter** sends. **Ctrl+K** focuses the box (`/` stays with the top-left search).

**Expanded** (after the first message):
- **Thread:** sits above the input and is scrollable, up to 40vh.
  - The visitor's messages are right-aligned blue bubbles.
  - The assistant's messages are left-aligned plain text. Above each sits a small "who" line: model name, "searched 2,467 films".
- **Film chips:** inline in the reply, with a gold number and the title. Hovering a chip pulses its dot; clicking opens the card.
- **Suggestion chips:** under the latest answer the model offers 3–4 follow-ups ("Only comedies", "Darker", "More like #2"). Clicking one sends it.
- **Bottom row:** input, **Clear** (ends the conversation and removes the glow) and a send button.
- **Collapse button:** shrinks the dock back to the pill and keeps the glow.

**States:**

| State | What shows |
|---|---|
| Thinking | Three pulsing dots and the step: "Understanding…", then "Searching 2,467 films…", then "Writing…" |
| Streaming | Text arrives word by word. Films glow **as soon as the search step returns**, before the text finishes. |
| No match | "I couldn't find films on the map for that," with suggestions to broaden it. Nothing glows. |
| Model offline | "The assistant isn't running (start Ollama)." The normal search still works. |
| Error or timeout | A short message and a **Retry** button. |

**The recommend tray** (♥ picks) moves to a slim row above the chat input, so the two don't stack. The chat can use the picks: "recommend from my likes" sends them along.

## 1.2 Glow layer on the map (`VectorMap.ts`)

- **New state:** `chat: { films: number[]; hover: number | null } | null`, drawn after the dots like the existing `rec` layer.
- **Each result** gets three things:
  - a gold radial halo (`#ffd36e`, 30 px)
  - a ring in its kind colour
  - a numbered badge at the top right and the title underneath. The labels go through the existing collision boxes, so they avoid each other.
- **Dimming:** the other films drop to 22% alpha, and the kind labels to 55%.
- **Camera:** fits the bounding box of the results, with padding, between the panels.
- **Hover:** hovering a chat row or chip gives that dot a white ring and a brighter halo.
- **Clicking a result:** it becomes `selected`. Its 8 neighbour lines draw as today and the chat glow stays.
- **Several answers:** only the latest answer glows. Earlier answers' chips are still clickable and re-light their films.

## 1.3 Right panel: "From chat"

- **Title:** "From chat", the film count, and the question in italics underneath.
- **Each row:**
  - number badge, poster (`w92`), kind dot, title, year
  - **why:** one line written by the model, grounded in the retrieved text
  - **source:** "from the film's Wikipedia plot", or "from the model's general knowledge". The second is shown muted so visitors can tell the two apart.
- **Films not on the map:** a separate group, "Not on the map yet", with title and year only. A later phase adds them live.
- **Switching:** the panel switches to "Similar films" when a film card is opened, and back with a "← Chat results (8)" link.

## 1.4 Mobile

- The chat becomes a bottom sheet, 45% tall when open.
- The "From chat" list scrolls horizontally inside the sheet, above the input.
- The glow on the map is unchanged.

## 1.5 Build order for Part 1 (no AI needed yet)

1. Build the dock, glow layer and panel against a **stub `/api/chat`**. The stub runs the existing tag-vector and keyword search on the message and returns the result shape from 2.6.
2. Check:
   - the films light up
   - the camera fits them
   - chips, rows and dots all open the card
   - Clear removes everything
   - Esc and the keyboard work
   - the mobile sheet works
3. Then swap the stub for the real engine (Part 2). Nothing in the UI changes.

---

# Part 2: the intelligence

## 2.1 Why not GPT-2

GPT-2 (124M) predates instruction-following:
- It can't reliably follow a request.
- It can't produce valid JSON.
- It knows little about films and has a 1,024-token context.

Use a modern **instruction-tuned** open model instead. On this laptop (RTX 3050 with 6 GB VRAM, 23 GB RAM, Ollama installed):

| Job | Model (run through Ollama) | Why |
|---|---|---|
| Chat and query understanding | A 7–8B instruct model at 4-bit, e.g. **Qwen 2.5/3 7–8B Instruct** or **Llama 3.1 8B Instruct** (about 5 GB) | Follows instructions, returns JSON, knows a lot about films. Fits in 6 GB VRAM. |
| Fallback when speed matters | A 3–4B instruct model (e.g. Qwen 2.5 3B, Llama 3.2 3B) | About twice as fast. Good enough for parsing, weaker for writing. |
| Embeddings (semantic search) | **nomic-embed-text** or **bge-m3** | Small (~0.3–0.6 GB). Turns "rich lifestyle" and plot text into vectors that can be compared. |
| Re-ranking (optional) | **bge-reranker-v2-m3** | Re-orders the top 50 for precision. Add only if the evaluation shows it helps. |

Pick the best model of each size that's in Ollama when this is built. The hard requirement is reliable JSON / tool-call output.

The model sits behind one small interface (`lib/ai/provider.ts`), so a hosted model (Claude, etc.) could be switched in by config later without touching the rest.

## 2.2 Where the knowledge comes from

A query like "rich lifestyle" can't be answered from TMDB genres and keywords. It needs **text about what happens in each film** (RAG) plus the model's general film knowledge.

1. **Film corpus for RAG, built offline. This is the main source.**
   - For every film on the map, fetch its English **Wikipedia plot and themes** sections.
   - Get basic facts from **Wikidata**: country, awards, "based on", main subject, narrative location.
   - Join to the map by Wikidata's *TMDB movie ID* (P4947) or *IMDb ID* (P345).
   - Licences: Wikipedia is CC BY-SA and Wikidata is CC0. Both allow this use with attribution, which the panel's "source" line provides.
   - Expect 90%+ coverage of the map's well-known films.
2. **The model's own knowledge.** It can suggest films from memory ("you'd like Gatsby").
   - These must be **matched to a real film** on the map (by title and year), or shown under "Not on the map yet".
   - The model is never allowed to invent a film that isn't matched.
3. **Live lookup (later, optional).** A film or topic missing from the corpus can be looked up through the Wikipedia API, which is fast, stable and licence-clear.
   - Don't scrape random websites: it's slow and brittle, and pages can carry hidden instructions to the model.

**TMDB rule, still in force.** The engine plan records that TMDB's terms forbid using TMDB content with ML/AI. So:
- The semantic index is built **only from Wikipedia and Wikidata text**.
- TMDB keeps doing what it does today: posters, the map, and the tag-vector "similar films".
- Before launch, re-read TMDB's current terms and confirm that showing TMDB posters next to AI answers is fine. Ask them if it's unclear.

## 2.3 What happens when a message arrives

```
message ─► 1 understand ─► 2 retrieve ─► 3 combine & filter ─► 4 answer ─► UI
              (LLM→JSON)     (3 searches)     (code, no LLM)      (LLM, streamed)
```

### Step 1: Understand (LLM, JSON only)

Turn the message, plus the conversation so far, into a structured query, validated with zod:

```json
{
  "intent": "find",
  "about": "films showing a rich, luxurious lifestyle; wealth, mansions, parties, excess",
  "like": [],
  "filters": { "kinds": [], "yearFrom": null, "yearTo": null, "languages": [], "maxRuntime": null },
  "exclude": { "kinds": [], "about": [] },
  "count": 8,
  "refine": null
}
```

- **`intent`:** one of `find` | `refine` | `like` (more like a film) | `question` (about one film) | `chat` (small talk).
- **`about`:** the request rewritten as a description, which embeds much better than "I want to watch…".
- **`like`:** films named by the visitor, matched to map ids.
- **`refine`:** follow-ups ("only comedies", "darker") **edit the previous query** instead of starting over. "More like #2" turns into `like: [id of #2]`.

### Step 2: Retrieve (three searches, run in parallel)

| Search | Finds | Good for |
|---|---|---|
| **Semantic:** embed `about` and compare it with the plot/theme chunks | Films whose story matches the meaning | "rich lifestyle", "a heist that goes wrong", "lonely robot" |
| **Keyword (BM25):** over plots, keywords and titles | Exact words and names | "Hitchcock", "Tokyo", "chess" |
| **Taste:** the existing TF-IDF tag vectors from `like` films (Rocchio, already built) | Films similar to named films | "like Parasite", "from my likes" |

Each search returns its top 50.

### Step 3: Combine and filter (plain code)

- **Merge** the three lists with reciprocal rank fusion. It's simple and robust, and needs no tuning.
- **Apply the hard filters:** kind, years, language, runtime and excludes.
  - A filter is never relaxed silently. If it leaves too few films, the reply says so and offers to relax it.
- **Optional:** re-rank the top 30 with the reranker.
- **Variety:** use MMR (already in `recommend.ts`), so 8 results aren't 8 near-identical films.
- **Keep the top `count`,** each with the plot passage that matched best.

### Step 4: Answer (LLM, streamed)

- **What the model gets:**
  - the question
  - the chosen films, as id, title and year
  - each film's best passage
  - a strict instruction: *only talk about these films, use their ids, say why each fits in one line, offer 3 follow-ups*
- **What it returns:**
  - a short reply with `[[id]]` markers, which the UI turns into chips
  - a `why` line per film
  - the follow-up suggestions
- **Checks on the output:**
  - Any id that isn't in the candidate list is **dropped**.
  - A film the model mentions from memory is matched by title and year. If there's no match, it goes under "Not on the map yet".

The films glow **after Step 3**, so the map reacts in about a second while the text streams in.

## 2.4 Conversation memory

- **Per conversation:** the last structured query, the last results (for "#2"), and the last 6 messages.
- **Where it's kept:** in the browser (`sessionStorage`), sent with each request, so the server holds no state.
- **"Clear"** wipes it.

## 2.5 Indexing (`npm run ai:index`)

1. Read `public/data/map.json`. For each film, query Wikidata by TMDB id (with an IMDb-id fallback) to get the Wikipedia article.
2. Fetch the plot and themes sections through the Wikipedia API, with a cache in `.cache/wiki/` (same pattern as the TMDB cache).
3. Split into chunks of about 200–400 words. Embed each chunk with the embedding model.
4. Write `data/ai/chunks.jsonl` (film id, section, text, source URL) and `data/ai/vectors.f32` (the embeddings).
   - About 2,500 films × ~4 chunks = ~10k vectors. **Brute-force search in memory takes milliseconds,** so no vector database is needed at this size.
   - Move to pgvector when the engine plan's Postgres arrives.
5. Re-runs are incremental: only new or changed films are embedded again.

## 2.6 API (`app/api/chat/route.ts`)

- **Request:** `POST { messages: [{role, text}], state: { query, results }, picks?: {like, dislike} }`
- **Response:** a stream of server-sent events:
  - `step` (`understanding` | `searching` | `writing`)
  - `results` (`[{ id, rank, why?, source }]`, sent as soon as Step 3 is done)
  - `text` (chunks)
  - `done` (`{ suggestions, state }`)
  - `error`
- **Limits:**
  - zod validation on the way in and out
  - message ≤ 500 characters, at most 20 turns
  - per-IP rate limit (copy `lib/rateLimit.ts` from `mov`)
  - 30 s timeout
- **Model offline:** the route returns `error: offline` and the UI shows its offline state.
- **Logs:** no message text is logged unless the owner opts in.

## 2.7 Is it any good? An evaluation set

Write `data/ai/eval.json`: about 60 real-sounding requests, each with films that **should** appear and films that **must not**. For example:
- "rich lifestyle" must include at least 3 of Gatsby, Wolf of Wall Street, Crazy Rich Asians, Saltburn, Triangle of Sadness.
- "like Parasite but funnier" must not return horror.

`npm run ai:eval` reports:
- hit-rate@8
- the number of invented films (must be 0)
- how often filters are respected (must be 100%)
- median time to first glow and to the full answer

Model choice, chunk size and the reranker are all decided by this report, not by guesswork.

---

## Phases

| Phase | Builds | Done when |
|---|---|---|
| **1. UI with a stub** | Chat dock, glow layer, "From chat" panel, mobile sheet, stub `/api/chat` on the existing search | The 1.5 checks pass in `scripts/check.mjs`; screenshots `docs/chat*.png` |
| **2. Corpus and index** | Wikidata join, Wikipedia plots, chunks, embeddings, `ai:index` | ≥ 90% of the map's films have text; a semantic-only search for "rich lifestyle" puts at least 3 of the expected films in its top 8 |
| **3. Understand + retrieve** | Ollama provider, Step 1 JSON with zod, hybrid search, fusion, filters, MMR | `ai:eval` hit-rate@8 ≥ 0.6 using retrieval only (no answer text yet) |
| **4. Answer + conversation** | Step 4 streaming, `[[id]]` chips, why lines, suggestions, refine and memory | 0 invented films; refinements ("only comedies") keep the earlier intent; first glow in under 2 s on this laptop |
| **5. Polish** | Optional reranker, "Not on the map yet", live Wikipedia lookup, hosted-model switch | Measured gains in `ai:eval`; no regression in map checks |

## Not in this plan

- Accounts and saved chats.
- Voice input.
- Scraping arbitrary websites.
- Training or fine-tuning a model.
- Facts that need deep research, such as which scenes were cut and by whom. These come from sources only, with "unknown" when there's no evidence (see `plans/intelligent-search.md`).
