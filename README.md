# Readwise → Obsidian Knowledge Graph

Sync your [Readwise](https://readwise.io) library into an [Obsidian](https://obsidian.md) vault as an interconnected knowledge graph. Documents, highlights, tags, authors, and categories become linked markdown notes you can explore with Obsidian's graph view.

## What it does

- Pulls **Reader documents** (articles, PDFs, videos, tweets, podcasts, etc.) and **Readwise highlights** via the [Readwise CLI](https://www.npmjs.com/package/@readwise/cli)
- Generates an Obsidian vault with `[[wikilinks]]` between everything:
  - `Documents/` — one note per saved item, with frontmatter metadata
  - `Tags/` — one note per tag, linking back to all tagged documents
  - `Authors/` — one note per author, linking to their works
  - `Categories/` — article, video, pdf, epub, etc.
  - `Home.md` — map of content with stats and recent items
- **Delta sync** — first run fetches everything; subsequent runs only fetch items updated since last sync
- Preconfigured Obsidian graph colors (blue = docs, orange = tags, green = authors, pink = categories)

## Prerequisites

1. [Node.js](https://nodejs.org) (v18+)
2. [Readwise CLI](https://www.npmjs.com/package/@readwise/cli) installed and authenticated:

```bash
npm install -g @readwise/cli
readwise login
```

## Usage

```bash
git clone https://github.com/terpjwu1/readwise-cli-integration-obsidian-vault.git
cd readwise-cli-integration-obsidian-vault

# Full sync (first run, or to re-fetch everything)
node sync.mjs --full

# Delta sync (only new/updated items since last run)
node sync.mjs

# Test with a small batch
node sync.mjs --limit 50
```

Then open the `vault/` folder in Obsidian ("Open folder as vault") and hit `Cmd+G` to see the graph.

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
