#!/usr/bin/env node
/**
 * Readwise → Obsidian Knowledge Graph Sync
 *
 * Pulls Reader documents + Readwise highlights via the CLI,
 * then generates an Obsidian vault with wikilinks between
 * documents, tags, authors, and categories.
 *
 * Supports delta sync: saves state to .sync-state.json and only
 * fetches items updated since last sync on subsequent runs.
 *
 * Usage:
 *   node sync.mjs              # Delta sync (or full if first run)
 *   node sync.mjs --full       # Force full sync
 *   node sync.mjs --limit 50   # Limit items fetched (for testing)
 */

import { execFileSync } from "child_process";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
} from "fs";
import { join } from "path";

// ── Config ──────────────────────────────────────────────────────────────────
const VAULT_DIR = join(process.cwd(), "vault");
const STATE_FILE = join(process.cwd(), ".sync-state.json");
const args = process.argv.slice(2);
const limitFlag = args.indexOf("--limit");
const LIMIT = limitFlag !== -1 ? parseInt(args[limitFlag + 1], 10) : Infinity;
const FULL_SYNC = args.includes("--full");

// ── State management ────────────────────────────────────────────────────────

function loadState() {
  if (existsSync(STATE_FILE)) {
    return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  }
  return { lastDocSync: null, lastHighlightSync: null, docIndex: {}, highlightIndex: {} };
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ── CLI helpers ─────────────────────────────────────────────────────────────

function rw(command, opts = {}) {
  const cmdArgs = [command];
  for (const [k, v] of Object.entries(opts)) {
    cmdArgs.push(`--${k}`, String(v));
  }
  cmdArgs.push("--json");
  const out = execFileSync("readwise", cmdArgs, {
    encoding: "utf-8",
    maxBuffer: 50 * 1024 * 1024,
  });
  return JSON.parse(out);
}

// ── Data fetching with pagination + delta ───────────────────────────────────

async function fetchDocuments(since) {
  const docs = [];
  let cursor = null;
  let page = 0;
  const pageSize = 100;
  const mode = since ? `delta (since ${since})` : "full";

  while (docs.length < LIMIT) {
    page++;
    const remaining = LIMIT - docs.length;
    const thisLimit = Math.min(pageSize, remaining);
    const opts = {
      limit: thisLimit,
      "response-fields":
        "title,author,category,tags,summary,source_url,url,published_date,saved_at,updated_at,reading_progress,word_count",
    };
    if (cursor) opts["page-cursor"] = cursor;
    if (since) opts["updated-after"] = since;

    process.stdout.write(
      `\r  [${mode}] Fetching documents page ${page}... (${docs.length} so far)`
    );
    let result;
    let retries = 3;
    while (retries > 0) {
      try {
        result = rw("reader-list-documents", opts);
        break;
      } catch (e) {
        retries--;
        if (retries === 0) {
          console.error(
            `\n  Error fetching page ${page} (giving up): ${e.message}`
          );
          return docs;
        }
        const wait = (4 - retries) * 30000;
        console.log(
          `\n  Rate limited on page ${page}, waiting ${wait / 1000}s... (${retries} retries left)`
        );
        await new Promise((r) => setTimeout(r, wait));
      }
    }

    if (!result.results || result.results.length === 0) break;
    docs.push(...result.results);

    cursor = result.nextPageCursor;
    if (!cursor) break;
  }
  console.log(`\r  Fetched ${docs.length} documents (${mode}).                    `);
  return docs;
}

async function fetchHighlights(since) {
  const highlights = [];
  let page = 1;
  const mode = since ? `delta (since ${since})` : "full";

  while (highlights.length < LIMIT) {
    process.stdout.write(
      `\r  [${mode}] Fetching highlights page ${page}... (${highlights.length} so far)`
    );
    let result;
    let retries = 3;
    const hlOpts = {
      "page-size": 100,
      page,
      "response-fields":
        "text,note,tags,highlighted_at,updated,book_id,book_title,book_author,book_category,book_source_url",
    };
    if (since) hlOpts["updated-gt"] = since;

    while (retries > 0) {
      try {
        result = rw("readwise-list-highlights", hlOpts);
        break;
      } catch (e) {
        retries--;
        if (retries === 0) {
          console.error(
            `\n  Error fetching highlights page ${page} (giving up): ${e.message}`
          );
          return highlights;
        }
        const wait = (4 - retries) * 30000;
        console.log(
          `\n  Rate limited on highlights page ${page}, waiting ${wait / 1000}s... (${retries} retries left)`
        );
        await new Promise((r) => setTimeout(r, wait));
      }
    }

    if (!result.results || result.results.length === 0) break;
    highlights.push(...result.results);
    if (!result.next) break;
    page++;
  }
  console.log(
    `\r  Fetched ${highlights.length} highlights (${mode}).                    `
  );
  return highlights;
}

// ── Vault generation ────────────────────────────────────────────────────────

function sanitize(name) {
  if (!name) return "Untitled";
  return name
    .replace(/[\\/:*?"<>|#^[\]]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function slugTag(tag) {
  return sanitize(tag).toLowerCase().replace(/\s+/g, "-");
}

function yamlEscape(str) {
  if (!str) return '""';
  if (/[:#{}[\],&*?|>!'"%@`]/.test(str) || str.includes("\n")) {
    return `"${str.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
  }
  return str;
}

function buildDocNote(doc, highlightsByBookTitle) {
  const title = doc.title || "Untitled";
  const author = doc.author || null;
  const tags = Object.keys(doc.tags || {});
  const category = doc.category || "article";

  let md = "---\n";
  md += `title: ${yamlEscape(title)}\n`;
  if (author) md += `author: ${yamlEscape(author)}\n`;
  md += `category: ${category}\n`;
  if (doc.source_url) md += `source_url: ${yamlEscape(doc.source_url)}\n`;
  if (doc.url) md += `url: ${yamlEscape(doc.url)}\n`;
  if (doc.published_date) md += `published_date: ${doc.published_date}\n`;
  if (doc.saved_at) md += `saved_at: ${doc.saved_at}\n`;
  if (doc.word_count) md += `word_count: ${doc.word_count}\n`;
  if (doc.reading_progress != null)
    md += `reading_progress: ${Math.round(doc.reading_progress * 100)}%\n`;
  if (tags.length)
    md += `tags:\n${tags.map((t) => `  - ${slugTag(t)}`).join("\n")}\n`;
  md += `id: ${doc.id}\n`;
  md += "---\n\n";

  md += `# ${title}\n\n`;
  if (author) md += `**Author:** [[Authors/${sanitize(author)}|${author}]]\n`;
  md += `**Category:** [[Categories/${category}]]\n`;
  if (tags.length) {
    md += `**Tags:** ${tags.map((t) => `[[Tags/${slugTag(t)}|${t}]]`).join(", ")}\n`;
  }
  if (doc.source_url) md += `**Source:** [Link](${doc.source_url})\n`;
  md += "\n";

  if (doc.summary) {
    md += `## Summary\n\n${doc.summary}\n\n`;
  }

  const docHighlights = highlightsByBookTitle.get(title) || [];
  if (docHighlights.length > 0) {
    md += `## Highlights\n\n`;
    for (const h of docHighlights) {
      const text = (h.text || "").trim();
      if (!text) continue;
      const display = text.length > 500 ? text.slice(0, 500) + "..." : text;
      md += `> ${display.replace(/\n/g, "\n> ")}\n`;
      if (h.note) md += `\n**Note:** ${h.note}\n`;
      const hTags = (h.tags || []).filter((t) => t.name);
      if (hTags.length) {
        md += `*Tags: ${hTags.map((t) => `[[Tags/${slugTag(t.name)}|${t.name}]]`).join(", ")}*\n`;
      }
      md += "\n";
    }
  }

  return md;
}

function buildTagNote(tagName, docTitles) {
  let md = `---\ntag: ${slugTag(tagName)}\ntype: tag\n---\n\n`;
  md += `# ${tagName}\n\n`;
  md += `${docTitles.length} documents tagged.\n\n`;
  for (const t of docTitles) {
    md += `- [[Documents/${sanitize(t)}|${t}]]\n`;
  }
  return md;
}

function buildAuthorNote(author, docTitles) {
  let md = `---\nauthor: ${yamlEscape(author)}\ntype: author\n---\n\n`;
  md += `# ${author}\n\n`;
  md += `${docTitles.length} documents.\n\n`;
  for (const t of docTitles) {
    md += `- [[Documents/${sanitize(t)}|${t}]]\n`;
  }
  return md;
}

function buildCategoryNote(category, docTitles) {
  let md = `---\ncategory: ${category}\ntype: category\n---\n\n`;
  md += `# ${category}\n\n`;
  md += `${docTitles.length} documents.\n\n`;
  for (const t of docTitles) {
    md += `- [[Documents/${sanitize(t)}|${t}]]\n`;
  }
  return md;
}

function buildMOC(stats) {
  let md = `# Readwise Knowledge Graph\n\n`;
  md += `*Last synced: ${new Date().toISOString().split("T")[0]}*\n\n`;
  md += `## Stats\n\n`;
  md += `- **Documents:** ${stats.docs}\n`;
  md += `- **Highlights:** ${stats.highlights}\n`;
  md += `- **Tags:** ${stats.tags}\n`;
  md += `- **Authors:** ${stats.authors}\n`;
  md += `- **Categories:** ${stats.categories}\n\n`;
  md += `## Browse\n\n`;
  md += `- **By Category:** ${stats.categoryList.map((c) => `[[Categories/${c}]]`).join(" | ")}\n`;
  md += `- **By Tag:** Browse the [[Tags/]] folder\n`;
  md += `- **By Author:** Browse the [[Authors/]] folder\n\n`;
  md += `## Recent Documents\n\n`;
  for (const t of stats.recentDocs.slice(0, 20)) {
    md += `- [[Documents/${sanitize(t)}|${t}]]\n`;
  }
  return md;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("Readwise → Obsidian Knowledge Graph Sync\n");

  const state = loadState();
  const isFirstRun = !state.lastDocSync || FULL_SYNC;

  if (isFirstRun) {
    console.log(FULL_SYNC ? "Mode: FULL (forced)\n" : "Mode: FULL (first run)\n");
  } else {
    console.log(`Mode: DELTA (since ${state.lastDocSync})\n`);
  }

  const syncTime = new Date().toISOString();

  // ── 1. Fetch data ──
  console.log("Step 1: Fetching data from Readwise...");
  const since = isFirstRun ? null : state.lastDocSync;
  const freshDocs = await fetchDocuments(since);
  const freshHighlights = await fetchHighlights(
    isFirstRun ? null : state.lastHighlightSync
  );

  // ── 2. Merge with existing state ──
  console.log("\nStep 2: Merging data...");

  // Merge docs: existing index + new/updated
  const docIndex = isFirstRun ? {} : { ...state.docIndex };
  let newCount = 0;
  let updatedCount = 0;
  for (const doc of freshDocs) {
    if (docIndex[doc.id]) {
      updatedCount++;
    } else {
      newCount++;
    }
    docIndex[doc.id] = doc;
  }
  const allDocs = Object.values(docIndex);
  console.log(
    `  Documents: ${allDocs.length} total (${newCount} new, ${updatedCount} updated)`
  );

  // Merge highlights
  const highlightIndex = isFirstRun ? {} : { ...state.highlightIndex };
  let hlNew = 0;
  let hlUpdated = 0;
  for (const h of freshHighlights) {
    if (highlightIndex[h.id]) {
      hlUpdated++;
    } else {
      hlNew++;
    }
    highlightIndex[h.id] = h;
  }
  const allHighlights = Object.values(highlightIndex);
  console.log(
    `  Highlights: ${allHighlights.length} total (${hlNew} new, ${hlUpdated} updated)`
  );

  // ── 3. Index highlights by book title ──
  console.log("\nStep 3: Building graph indices...");
  const highlightsByBookTitle = new Map();
  for (const h of allHighlights) {
    const key = h.book_title || "Unknown";
    if (!highlightsByBookTitle.has(key)) highlightsByBookTitle.set(key, []);
    highlightsByBookTitle.get(key).push(h);
  }

  const tagToDocs = new Map();
  const authorToDocs = new Map();
  const categoryToDocs = new Map();

  for (const doc of allDocs) {
    const title = doc.title || "Untitled";
    const tags = Object.keys(doc.tags || {});
    const author = doc.author || null;
    const category = doc.category || "article";

    for (const tag of tags) {
      if (!tagToDocs.has(tag)) tagToDocs.set(tag, []);
      tagToDocs.get(tag).push(title);
    }
    if (author) {
      if (!authorToDocs.has(author)) authorToDocs.set(author, []);
      authorToDocs.get(author).push(title);
    }
    if (!categoryToDocs.has(category)) categoryToDocs.set(category, []);
    categoryToDocs.get(category).push(title);
  }

  console.log(
    `  ${tagToDocs.size} tags, ${authorToDocs.size} authors, ${categoryToDocs.size} categories`
  );

  // ── 4. Write vault ──
  console.log("\nStep 4: Writing Obsidian vault...");

  // Ensure directories exist (don't wipe on delta)
  for (const dir of ["Documents", "Tags", "Authors", "Categories"]) {
    mkdirSync(join(VAULT_DIR, dir), { recursive: true });
  }

  // Documents — write all (fast enough, ensures consistency)
  const seenFilenames = new Set();
  for (const doc of allDocs) {
    let filename = sanitize(doc.title || "Untitled");
    if (seenFilenames.has(filename)) {
      filename = `${filename} (${doc.id.slice(-6)})`;
    }
    seenFilenames.add(filename);
    const content = buildDocNote(doc, highlightsByBookTitle);
    writeFileSync(join(VAULT_DIR, "Documents", `${filename}.md`), content);
  }
  console.log(`  Wrote ${allDocs.length} document notes.`);

  // Tags — rebuild (they reference all docs)
  for (const [tag, docTitles] of tagToDocs) {
    writeFileSync(
      join(VAULT_DIR, "Tags", `${slugTag(tag)}.md`),
      buildTagNote(tag, docTitles)
    );
  }
  console.log(`  Wrote ${tagToDocs.size} tag notes.`);

  // Authors
  for (const [author, docTitles] of authorToDocs) {
    writeFileSync(
      join(VAULT_DIR, "Authors", `${sanitize(author)}.md`),
      buildAuthorNote(author, docTitles)
    );
  }
  console.log(`  Wrote ${authorToDocs.size} author notes.`);

  // Categories
  for (const [cat, docTitles] of categoryToDocs) {
    writeFileSync(
      join(VAULT_DIR, "Categories", `${cat}.md`),
      buildCategoryNote(cat, docTitles)
    );
  }
  console.log(`  Wrote ${categoryToDocs.size} category notes.`);

  // MOC
  writeFileSync(
    join(VAULT_DIR, "Home.md"),
    buildMOC({
      docs: allDocs.length,
      highlights: allHighlights.length,
      tags: tagToDocs.size,
      authors: authorToDocs.size,
      categories: categoryToDocs.size,
      categoryList: [...categoryToDocs.keys()],
      recentDocs: allDocs.slice(0, 20).map((d) => d.title || "Untitled"),
    })
  );

  // Obsidian config
  const obsidianDir = join(VAULT_DIR, ".obsidian");
  mkdirSync(obsidianDir, { recursive: true });
  writeFileSync(
    join(obsidianDir, "app.json"),
    JSON.stringify(
      {
        useMarkdownLinks: false,
        newFileLocation: "folder",
        newFileFolderPath: "Documents",
        showFrontmatter: true,
      },
      null,
      2
    )
  );
  writeFileSync(
    join(obsidianDir, "graph.json"),
    JSON.stringify(
      {
        collapse: {
          search: false,
          query: { string: "" },
          colorGroups: [
            { query: "path:Documents", color: { a: 1, rgb: 5614335 } },
            { query: "path:Tags", color: { a: 1, rgb: 16744448 } },
            { query: "path:Authors", color: { a: 1, rgb: 65408 } },
            { query: "path:Categories", color: { a: 1, rgb: 16711935 } },
          ],
        },
        search: "",
        showTags: true,
        showAttachments: false,
        hideUnresolved: false,
        showOrphans: true,
        lineSizeMultiplier: 1,
        nodeSizeMultiplier: 1,
        force: {
          centerStrength: 0.5,
          repelStrength: 10,
          linkStrength: 1,
          linkDistance: 100,
        },
      },
      null,
      2
    )
  );

  // ── 5. Save state ──
  saveState({
    lastDocSync: syncTime,
    lastHighlightSync: syncTime,
    docIndex,
    highlightIndex,
  });

  console.log(`\nDone! Vault written to: ${VAULT_DIR}`);
  console.log(`State saved to: ${STATE_FILE}`);
  console.log(
    `\nNext run will only fetch items updated after ${syncTime}`
  );
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
