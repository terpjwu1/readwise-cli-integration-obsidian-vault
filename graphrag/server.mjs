#!/usr/bin/env node
import express from "express";
import { execFile } from "child_process";
import { promisify } from "util";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const exec = promisify(execFile);
const __dir = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());
app.use(express.static(join(__dir, "ui")));

async function rw(command, opts = {}) {
  const args = [command];
  for (const [k, v] of Object.entries(opts)) {
    if (v === null || v === undefined) continue;
    args.push(`--${k}`, String(v));
  }
  args.push("--json");
  const { stdout } = await exec("readwise", args, {
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

// Search endpoint — calls both MCP tools and returns results with tool call metadata
app.post("/api/search", async (req, res) => {
  const { query, limit = 10 } = req.body;
  if (!query) return res.status(400).json({ error: "query required" });

  const toolCalls = [];
  const results = [];

  try {
    // Tool 1: reader_search_documents
    const t1Start = Date.now();
    const docs = await rw("reader-search-documents", { query, limit });
    const t1Ms = Date.now() - t1Start;
    toolCalls.push({
      tool: "reader_search_documents",
      args: { query, limit },
      ms: t1Ms,
      count: docs.length,
    });
    for (const doc of docs) {
      results.push({
        type: "document",
        id: doc.document_id,
        title: doc.title,
        author: doc.author,
        category: doc.category,
        url: doc.url,
        tags: doc.tags || [],
        matches: (doc.matches || []).map((m) => m.plaintext).slice(0, 2),
        source: "reader_search_documents",
      });
    }
  } catch (e) {
    toolCalls.push({
      tool: "reader_search_documents",
      args: { query, limit },
      error: e.message,
    });
  }

  try {
    // Tool 2: readwise_search_highlights
    const t2Start = Date.now();
    const highlights = await rw("readwise-search-highlights", {
      "vector-search-term": query,
      limit,
    });
    const t2Ms = Date.now() - t2Start;
    toolCalls.push({
      tool: "readwise_search_highlights",
      args: { vector_search_term: query, limit },
      ms: t2Ms,
      count: highlights.length,
    });
    for (const h of highlights) {
      const a = h.attributes || {};
      results.push({
        type: "highlight",
        id: h.id,
        text: a.highlight_plaintext || h.text || "",
        title: a.document_title || h.book_title || h.title || "",
        author: a.document_author || h.book_author || h.author || "",
        category: a.document_category || "",
        url: h.url,
        tags: a.highlight_tags || a.document_tags || h.tags || [],
        note: a.highlight_note || "",
        source: "readwise_search_highlights",
      });
    }
  } catch (e) {
    toolCalls.push({
      tool: "readwise_search_highlights",
      args: { vector_search_term: query, limit },
      error: e.message,
    });
  }

  res.json({ query, toolCalls, results });
});

app.listen(PORT, () => {
  console.log(`http://localhost:${PORT}`);
});
