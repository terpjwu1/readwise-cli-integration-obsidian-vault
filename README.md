# Readwise → Obsidian Knowledge Graph

Sync your [Readwise](https://readwise.io) library into an [Obsidian](https://obsidian.md) vault as an interconnected knowledge graph, and search it with a local web UI powered by the [Readwise MCP](https://readwise.io/mcp).

## What it does

**Vault sync** (via [Readwise CLI](https://www.npmjs.com/package/@readwise/cli)):
- Pulls **Reader documents** (articles, PDFs, videos, tweets, podcasts, etc.) and **Readwise highlights**
- Generates an Obsidian vault with `[[wikilinks]]` between everything:
  - `Documents/` — one note per saved item, with frontmatter metadata
  - `Tags/` — one note per tag, linking back to all tagged documents
  - `Authors/` — one note per author, linking to their works
  - `Categories/` — article, video, pdf, epub, etc.
  - `Home.md` — map of content with stats and recent items
- **Delta sync** — first run fetches everything; subsequent runs only fetch items updated since last sync
- Preconfigured Obsidian graph colors (blue = docs, orange = tags, green = authors, pink = categories)

**Search UI** (via [Readwise MCP](https://readwise.io/mcp)):
- Local web interface at `localhost:3000` for searching your library
- Calls `reader_search_documents` (hybrid search) and `readwise_search_highlights` (vector search) under the hood
- Results in two tabs: **Highlights** and **Documents**
- Shows tool call metadata (which MCP tool, result count, latency)
- Citations `[1]`, `[2]` on each result
- Obsidian `[[wikilinks]]` on document results that open the note directly in your vault

## Prerequisites

1. [Node.js](https://nodejs.org) (v18+)
2. [Readwise CLI](https://www.npmjs.com/package/@readwise/cli) installed and authenticated:

```bash
npm install -g @readwise/cli
readwise login
```

3. Install dependencies:

```bash
npm install
```

## Vault Sync

```bash
# Full sync (first run, or to re-fetch everything)
node sync.mjs --full

# Delta sync (only new/updated items since last run)
node sync.mjs

# Test with a small batch
node sync.mjs --limit 50
```

Then open the `vault/` folder in Obsidian ("Open folder as vault") and hit `Cmd+G` to see the graph.

## Search UI

```bash
npm run search
# → http://localhost:3000
```

Type a query to search across your documents and highlights. Results link back to Obsidian and Readwise.

## Claude Code MCP Integration

You can also add the Readwise MCP server directly to Claude Code for conversational search:

```bash
claude mcp add --transport http readwise https://mcp2.readwise.io/mcp
```

Then authenticate via `/mcp` in Claude Code. This gives Claude direct access to search your library, manage tags, create highlights, and more.

## How delta sync works

State is persisted in `.sync-state.json` after each run. It stores:
- Timestamps of the last sync
- A full index of all fetched documents and highlights

On subsequent runs, the script passes `--updated-after` / `--updated-gt` to the Readwise API so only new or modified items are fetched. These are merged into the existing index, and the entire vault is regenerated from the merged data.

To reset and start fresh, delete `.sync-state.json` or use `--full`.

## Rate limits

The Readwise API rate-limits after ~2,000 items per burst. The script automatically retries with backoff (30s, then 60s). A full sync of ~7,000 documents typically completes in a few minutes with 3-4 pauses.

## Generated note structure

Each document note looks like:

```markdown
---
title: "Article Title"
author: "Author Name"
category: article
source_url: "https://..."
tags:
  - ai
  - rag
id: 01abc123
---

# Article Title

**Author:** [[Authors/Author Name|Author Name]]
**Category:** [[Categories/article]]
**Tags:** [[Tags/ai|ai]], [[Tags/rag|rag]]
**Source:** [Link](https://...)

## Summary

AI-generated summary from Readwise...

## Highlights

> Highlighted text from the article...

**Note:** Your annotation here
```

## License

MIT
