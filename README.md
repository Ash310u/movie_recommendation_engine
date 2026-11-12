# reelgraph

About 2,500 films as a zoomable "galaxy" map: 13 kinds of film in coloured clusters with named
sub-clusters, the 8 most similar films for any film, highlighting by genre/keyword/director/kind,
a language filter, and recommendations from films you like. Design: `plans/vector-map-ui.md`.

## Run

```sh
npm install
npm run data      # TMDB → public/data/*.json (needs .tmdb-token; add TMDB_DNS=1.1.1.1 if DNS blocks TMDB)
npm run dev       # http://localhost:3000
npm run check     # build + headless checks, screenshots in docs/
```

`npm run data` caches every TMDB response in `.cache/tmdb/`, so reruns are offline and give the
same files. Settings: `PER_KIND` (default 190), `PER_LANG` (default 60).

## Chat (plans/chat-discovery.md)

Ask in plain words at the bottom of the map ("a movie where a rich lifestyle is shown", "like
Parasite but funnier", "90s crime thriller, not too long"). The films in the answer glow on the
map and are listed on the right with a reason each. Follow-ups refine the last search.

It runs locally through [Ollama](https://ollama.com):

```sh
ollama serve                      # if it isn't running as a service
ollama pull qwen3:4b-instruct     # chat model (CHAT_MODEL; use an instruct model, not a thinking one)
ollama pull mxbai-embed-large     # embedding model (EMBED_MODEL)
npm run ai:index                  # Wikipedia/Wikidata passages → data/ai/ (cached; reruns are quick)
npm run dev
BASE=http://localhost:3000 npm run ai:eval   # quality report on data/ai/eval.json
```

How a message is answered: the model turns it into a structured query (description, names,
genre/year/language/length filters, reference films); three searches run (meaning over the
Wikipedia passages, keywords, and the existing tag similarity for "like X"); plain code merges
them, applies the filters and picks a varied set; the model then writes a short reply about only
those films. Without Ollama the chat falls back to a keyword search and says so.

Only Wikipedia (CC BY-SA) and Wikidata (CC0) text goes into the AI index; TMDB content does not.

## How similarity works

Plain arithmetic, no ML: TMDB's terms rule out using its data with ML/AI models. Each film gets a
TF-IDF vector over its tags (keywords 1.0, director 1.5, top cast 0.6, genres 0.4, decade 0.3);
similar films are the highest cosine. Sub-clusters come from label propagation on the
nearest-film graph and are named by their most distinctive keywords and directors.
Recommendations: Rocchio over liked/disliked films, then MMR for variety, all in the browser.

## Not yet (see plans/)

No database yet: the data is static JSON. pgvector, live adding of films that aren't on the map,
and the API routes in `plans/movie-recommendation-engine.md` come later. Chat answers only cover
films on the map.

Film data and posters from TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB.
