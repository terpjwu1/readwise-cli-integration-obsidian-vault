# Readwise → Obsidian Knowledge Graph + RAG Search

Sync your [Readwise](https://readwise.io) library into an [Obsidian](https://obsidian.md) vault as an interconnected knowledge graph, then search it with a RAG-powered web UI that combines Readwise MCP, local graph traversal, and LLM answer generation.

## What it does

### 1. Vault Sync (`sync.mjs`)

Pulls Reader documents and Readwise highlights via the [Readwise CLI](https://www.npmjs.com/package/@readwise/cli) and generates an Obsidian vault with `[[wikilinks]]`:

- `Documents/` — one note per saved item (frontmatter + wikilinks + summary + highlights)
- `Tags/` — one note per tag with backlinks to all tagged documents
- `Authors/` — one note per author with backlinks
- `Categories/` — article, video, pdf, epub, etc.
- `Home.md` — map of content with stats and recent items
- Delta sync — subsequent runs only fetch new/updated items

### 2. Content Enrichment (`enrich.mjs`)

Fetches full article markdown from Readwise and appends it to vault documents:

- Calls `reader-get-document-details` for each document
- Appends a `## Content` section with the full article text (~10-20KB per doc)
- Delta support — tracks enriched docs in `.enrich-state.json`, skips already-enriched
- ~89% of docs (6,602 / 7,386) successfully enriched

### 3. Search UI + RAG (`graphrag/`)

Local web interface at `localhost:3000` with a three-stage retrieval pipeline:

**Retrieval:**
1. **Readwise MCP** — `reader_search_documents` (hybrid BM25 + semantic) and `readwise_search_highlights` (vector search, filtered at score ≥ 0.02)
2. **Graph expansion** — top 5 seed documents → follow `[[Tags/...]]` wikilinks in the vault → discover up to 15 neighbor documents ranked by tag overlap
3. **RRF merge** — [Reciprocal Rank Fusion](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf) (k=60) combines all three result lists into a single ranked output
4. **Codex Reranker** — asks Codex CLI to semantically reorder RRF candidates by relevance to the query. No external API key needed — uses your existing Codex subscription.

**Answer generation:**
- Reranked results are sent to [Codex CLI](https://github.com/openai/codex) for LLM synthesis (2-step Codex pipeline: rerank → answer)
- Top 5 results get 2KB of enriched vault content; remaining get 500 chars (tiered by reranker rank, not source type)
- Graph traversal surfaces related docs the user may not have searched for directly, giving the LLM broader context
- Generated answer appears above search results with clickable `[a]`, `[b]`, `[c]` citations

**UI features:**
- Three tabs: Documents, Graph (with tag overlap badges), Highlights
- Step indicator showing Codex rerank → answer pipeline progress with latency
- Tool call pills showing MCP tool name, result count, latency, and threshold filtering
- Clickable citations that scroll to and highlight the source card
- Obsidian `[[wikilinks]]` on document results

## Prerequisites

1. [Node.js](https://nodejs.org) (v18+)
2. [Readwise CLI](https://www.npmjs.com/package/@readwise/cli) installed and authenticated:

```bash
npm install -g @readwise/cli
readwise login
```

3. [Codex CLI](https://github.com/openai/codex) (for reranking + answer generation):

```bash
npm install -g @openai/codex
```

4. Install dependencies:

```bash
npm install
```

## Usage

```bash
# Vault sync
node sync.mjs              # Delta sync
node sync.mjs --full       # Full re-sync
node sync.mjs --limit 50   # Small test batch

# Enrich vault with full content
node enrich.mjs                    # All un-enriched docs
node enrich.mjs --limit 500       # Batch of 500
node enrich.mjs --category article # Articles only
node enrich.mjs --full             # Re-enrich everything

# Search UI
npm run search             # → http://localhost:3000
```

Then open `vault/` in Obsidian and hit `Cmd+G` to browse the graph.

## Architecture

```
User query
    │
    ├──→ Readwise MCP (remote)
    │     ├── reader_search_documents (hybrid search)
    │     └── readwise_search_highlights (vector, threshold ≥ 0.02)
    │
    ├──→ Graph expansion (local, ~7ms)
    │     └── Top 5 seeds → vault Tags/*.md → neighbor docs by tag overlap
    │
    └──→ RRF merge (k=60) → ranked results
                │
                ├──→ Codex CLI (step 1) → semantic reranking
                └──→ Codex CLI (step 2) → synthesized answer with citations
```

**Files:**
- `sync.mjs` — vault sync (delta + full)
- `enrich.mjs` — content enrichment via `reader-get-document-details`
- `graphrag/server.mjs` — Express server with `/api/search`, `/api/rerank`, and `/api/answer` endpoints
- `graphrag/ui/index.html` — single-page search interface

## Claude Code MCP Integration

Add the Readwise MCP server directly to Claude Code for conversational search:

```bash
claude mcp add --transport http readwise https://mcp2.readwise.io/mcp
```

Then authenticate via `/mcp` in Claude Code.

## How delta sync works

State is persisted in `.sync-state.json`. On subsequent runs, only items updated after the last sync timestamp are fetched and merged. The entire vault is regenerated from the merged index. To reset: delete `.sync-state.json` or use `--full`.

## Rate limits

The Readwise API rate-limits after ~2,000 items per burst. Scripts automatically retry with backoff (30s, then 60s). A full sync of ~7,000 documents completes in a few minutes with 3-4 pauses.

## License

MIT
