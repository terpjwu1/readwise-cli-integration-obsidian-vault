# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Readwise-to-Obsidian sync tool. Pulls Reader documents and Readwise highlights via the `@readwise/cli` and generates an Obsidian vault with `[[wikilinks]]` connecting documents, tags, authors, and categories.

Current vault: ~7,410 documents, ~2,827 highlights, ~358 tags, ~3,881 authors.

## Commands

```bash
node sync.mjs              # Delta sync (only new/updated since last run)
node sync.mjs --full       # Full re-sync from scratch
node sync.mjs --limit 50   # Small batch for testing
```

Requires `@readwise/cli` installed globally and authenticated (`readwise login`).

## Architecture

Single file: `sync.mjs` (ES modules, no build step).

**Data flow:** Readwise API → `@readwise/cli` (paginated fetch) → merge with `.sync-state.json` → generate vault markdown files.

**Delta sync:** `.sync-state.json` stores timestamps + full doc/highlight indices. On subsequent runs, only items updated after the last sync timestamp are fetched and merged. The entire vault is regenerated from the merged index.

**Vault structure:**
- `vault/Documents/` — one `.md` per document (YAML frontmatter + wikilinks + summary + highlights)
- `vault/Tags/` — one `.md` per tag with backlinks to documents
- `vault/Authors/` — one `.md` per author with backlinks
- `vault/Categories/` — article, video, pdf, etc.
- `vault/Home.md` — map of content
- `vault/.obsidian/` — preconfigured graph colors and settings

**Key functions in sync.mjs:**
- `rw(command, opts)` — shells out to `readwise` CLI with `--json` flag
- `fetchDocuments(since)` / `fetchHighlights(since)` — paginated fetch with retry/backoff for rate limits
- `sanitize(name)` — filesystem-safe filenames (120 char max, strips special chars)
- `slugTag(tag)` — lowercase hyphenated tag slugs
- `buildDocNote()` / `buildTagNote()` / `buildAuthorNote()` — markdown generators with wikilinks

## Rate Limits

Readwise API rate-limits after ~2,000 items per burst. The script retries with 30s/60s backoff (3 attempts). A full sync takes ~5 minutes with pauses.

## Readwise MCP

A Readwise MCP server is configured in `~/.claude/settings.json` (HTTP transport to `https://mcp2.readwise.io/mcp`). This gives Claude Code direct access to search documents, search highlights, get document details, manage tags, and more — without going through the CLI.
