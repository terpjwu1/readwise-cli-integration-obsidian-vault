#!/usr/bin/env node
/**
 * Enrich vault documents with full content from Readwise.
 *
 * Scans vault Documents/, fetches full markdown content via
 * reader-get-document-details, and appends a ## Content section.
 *
 * Usage:
 *   node enrich.mjs                    # Enrich all un-enriched docs
 *   node enrich.mjs --limit 500        # Enrich 500 then stop
 *   node enrich.mjs --category article # Only articles
 *   node enrich.mjs --full             # Re-enrich everything
 */

import { execFileSync } from "child_process";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";

const VAULT_DIR = join(process.cwd(), "vault", "Documents");
const STATE_FILE = join(process.cwd(), ".enrich-state.json");
const args = process.argv.slice(2);
const limitIdx = args.indexOf("--limit");
const LIMIT = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : Infinity;
const catIdx = args.indexOf("--category");
const CATEGORY = catIdx !== -1 ? args[catIdx + 1] : null;
const FULL = args.includes("--full");

function loadState() {
  if (existsSync(STATE_FILE) && !FULL) {
    return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  }
  return { enriched: {} };
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function extractFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fm = {};
  for (const line of match[1].split("\n")) {
    const m = line.match(/^(\w[\w_]*)\s*:\s*(.+)/);
    if (m) fm[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return fm;
}

function fetchDetails(docId) {
  const out = execFileSync(
    "readwise",
    ["reader-get-document-details", "--document-id", docId, "--json"],
    { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 }
  );
  return JSON.parse(out);
}

async function main() {
  console.log("Readwise Vault Enrichment\n");

  const state = loadState();
  const files = readdirSync(VAULT_DIR).filter((f) => f.endsWith(".md"));
  console.log(`Found ${files.length} vault documents.`);

  // Build work list
  const work = [];
  for (const file of files) {
    const path = join(VAULT_DIR, file);
    const content = readFileSync(path, "utf-8");
    const fm = extractFrontmatter(content);

    if (!fm.id) continue;
    if (CATEGORY && fm.category !== CATEGORY) continue;
    if (!FULL && state.enriched[fm.id]) continue;
    if (!FULL && content.includes("\n## Content\n")) continue;

    work.push({ file, path, content, id: fm.id, category: fm.category });
  }

  const total = Math.min(work.length, LIMIT);
  console.log(
    `${work.length} docs need enrichment${LIMIT < work.length ? `, processing ${total}` : ""}.${CATEGORY ? ` (category: ${CATEGORY})` : ""}\n`
  );

  if (total === 0) {
    console.log("Nothing to do.");
    return;
  }

  let enriched = 0;
  let errors = 0;

  for (let i = 0; i < total; i++) {
    const doc = work[i];
    process.stdout.write(
      `\r  [${i + 1}/${total}] Enriching: ${doc.file.slice(0, 60)}...`
    );

    let details;
    let retries = 3;
    while (retries > 0) {
      try {
        details = fetchDetails(doc.id);
        break;
      } catch (e) {
        retries--;
        if (retries === 0) {
          errors++;
          details = null;
          break;
        }
        const wait = (4 - retries) * 30000;
        console.log(
          `\n  Rate limited, waiting ${wait / 1000}s... (${retries} retries left)`
        );
        await new Promise((r) => setTimeout(r, wait));
      }
    }

    if (!details || !details.content) {
      continue;
    }

    // Append ## Content section
    let updated = doc.content;
    // Remove existing ## Content if re-enriching
    updated = updated.replace(/\n## Content\n[\s\S]*$/, "");
    updated = updated.trimEnd() + "\n\n## Content\n\n" + details.content + "\n";

    writeFileSync(doc.path, updated);
    state.enriched[doc.id] = new Date().toISOString();
    enriched++;

    // Save state every 50 docs
    if (enriched % 50 === 0) {
      saveState(state);
    }
  }

  saveState(state);
  console.log(
    `\n\nDone! Enriched ${enriched} docs, ${errors} errors, ${total - enriched - errors} skipped (no content).`
  );
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
