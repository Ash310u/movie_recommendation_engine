# Plan: natural-language discovery with evidence

> **Superseded by `plans/chat-discovery.md`.** Kept for the evidence rules on deep factual claims (e.g. scenes cut, and by whom).

Status: proposed, 2026-11-12. Extends the existing static map; no AI feature is implemented by this document.

## Product goal

Let a visitor describe what they want to watch in ordinary language, then show films on the map with an explanation of each match. Support both taste requests (slow-burning crime thrillers) and factual constraints (a particular release passed without violence-related cuts).

Example: “I want to watch a crime thriller where no scene was cut in production for too much brutality.”

This is not equivalent to “very violent crime thriller.” Preserve the negative constraint. Distinguish production edits, distributor edits, certification cuts, and restored footage. Do not silently change the request to “uncut release.”

## Query behavior

1. Parse the user's text into genres, mood/preferences, exclusions, factual predicates, and unresolved questions. Validate against a closed schema; the model cannot execute SQL or choose arbitrary fetch URLs.
2. For the example, retain crime AND thriller, plus the predicate `no production edits because of violence`, with scope unresolved. Ask inline: “Do you mean an uncut release you can watch, or no violent scenes removed during production?” Region/edition is needed for release-specific claims.
3. Retrieve candidates using available structured fields and independently licensed research data. Intersect all hard constraints; use the current similarity engine only for preference ranking, after data-use approval.
4. Resolve factual predicates against evidence records. Each predicate is supported, contradicted, or unknown; conflicting evidence remains visible and cannot produce a verified match. Missing cut records do not mean no cuts occurred.
5. Return verified matches separately from possible matches with missing evidence. Never relax a hard condition without a visible user choice. If none qualify, say so.
6. Highlight returned film IDs on the map and offer a keyboard-accessible result list. Films outside the map need a separate result card until live ingestion exists.

## Evidence model

Start with curated JSON, not a required database migration. A small reviewed corpus is more useful than unsupported claims across all 2,467 films.

- Film: stable internal ID, title/year, external identifiers for explicit identity matching.
- Release: film ID, territory, edition, distributor, medium, release date and runtime when known. Runtime alone does not establish identity.
- Claim: subject (film/release), predicate, value, stage (production/distribution/classification/restoration), reason, scope, and evidence IDs.
- Evidence: source URL/title/publisher, publication/access date, short permitted excerpt or paraphrase, relevant locator, rights/provenance, review status.
- Assessment: supported/contradicted/unknown, conflict flag, justification, supporting evidence IDs. No invented numeric confidence or similarity percentages as factual certainty.

“Passed without cuts” supports only the relevant classification submission. It does not prove that no footage was removed before submission, that another territory received the same edition, or that no production edits occurred. Negative historical claims require explicit evidence with a defined scope; otherwise remain unknown.

Prefer classification records for classification decisions, distributor release notes for edition details, and attributable filmmaker/editor interviews for production decisions. These are candidate sources, not pre-approved datasets: verify access, reuse, storage, and model-processing permissions separately. Do not scrape IMDb trivia or ingest full copyrighted articles by default.

## Architecture and project fit

Current app loads static JSON; `components/map/main.ts` wires search and `components/map/recommend.ts` ranks tag vectors in the browser. There is no search API or database yet.

Proposed files:

- `lib/search/query.ts`: validated query contract and clarification rules.
- `lib/search/evidence.ts`: pure predicate assessment and release-scope matching.
- `data/research/`: reviewed, independently sourced claims with provenance; keep separate from TMDB exports.
- `app/api/discover/route.ts`: bounded server-side orchestration, input/output validation, timeouts, rate limits and graceful provider failures.
- `components/map/`: natural-language input, interpretation chips, clarification controls, evidence cards, result highlights. Preserve existing title/tag search.

First use a model only to interpret user-written text into the schema. Deterministic code evaluates hard constraints and selects source-backed explanations. Optional semantic retrieval and answer generation follow only for material whose permissions allow them. No need for pgvector at this scale; adopt Postgres when persistent research/release ingestion needs it.

Research pages are untrusted data, never tool instructions. Use approved sources, URL/network restrictions, bounded fetches and no secrets in prompts. Cache reviewed claims, not unsupported generated answers. Keep API keys server-side and cap requests, candidate count, research calls and total spend.

## Data-use prerequisite

The existing engine plan explicitly prohibits AI/ML over TMDB content based on its prior terms review. This document does not override it. On 2026-11-12 the current terms URL could not be fetched by the browsing tool (robots denied), so its current wording is unverified:
https://www.themoviedb.org/api-terms-of-use

Before integrating AI into the TMDB-backed app, verify the current agreement and obtain any required permission, or use a source licensed for the intended application. Parsing only user text or separating storage must not be assumed to resolve an application-wide restriction. Until resolved, build/test the intelligence path against an independent, permitted fixture corpus and do not send TMDB titles, plots, tags, vectors, or derived results to a model.

BBFC submission guidance was accessible on 2026-11-12 and illustrates why evidence must be version-specific (full final edit; different versions may need separate assessment):
https://www.bbfc.co.uk/getting-a-bbfc-age-rating/cinema
This is a domain reference, not a grant of bulk-data or AI-processing rights.

## Delivery phases

1. **Evidence prototype:** create fictional fixtures and pure query/evidence contracts. Cover positive and negative predicates, scoped release claims, contradictions and missing evidence. Document provider/source permissions before real integration.
2. **Natural-language interpretation:** choose a provider, parse user text into validated JSON, expose ambiguity and interpreted constraints. Return a clear unavailable state when credentials/provider are absent; never fake AI responses.
3. **Reviewed discovery corpus:** curate a small permission-cleared set of films, releases and production claims. Implement retrieval and source-linked result cards; unknown claims stay out of strict matches.
4. **Map integration:** once data-use clearance is established, map confirmed identities to dots, preserve existing search/likes/filters, support list navigation and mobile layout. Handle out-of-map results explicitly.
5. **Optional research expansion:** add bounded live source lookup and reviewed claim caching only after source rights, latency and cost are measured. Embeddings are optional and restricted to permitted material.

## Acceptance checks

- Crime AND thriller does not become either genre; negation survives paraphrases.
- The example triggers the production-versus-release clarification.
- “No cuts recorded” and a rating of 18 never establish “no production cuts.”
- UK theatrical evidence cannot verify an Indian streaming edition.
- Previously cut/restored releases are represented separately; contradictory sources cannot yield verified matches.
- A strict request with zero supported candidates returns zero verified matches.
- Every factual result explanation resolves to stored evidence; source text cannot alter instructions or tool policy.
- Malformed model output, missing credentials, timeout and rate limits have explicit states.
- No protected data or secrets enter model prompts/logs; existing map interactions continue working.

No real-film recommendations or claims about production history have been verified as part of this plan.
