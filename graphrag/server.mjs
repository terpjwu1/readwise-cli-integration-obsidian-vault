#!/usr/bin/env node
import express from "express";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { readFileSync, existsSync, readdirSync } from "fs";

const exec = promisify(execFile);
const __dir = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const VAULT_DOCS = join(__dir, "..", "vault", "Documents");

function sanitize(name) {
  if (!name) return "Untitled";
  return name.replace(/[\\/:*?"<>|#^\[\]]/g, "-").replace(/\s+/g, " ").trim().slice(0, 120);
}

function getVaultContent(title, maxChars = 2000) {
  const file = join(VAULT_DOCS, sanitize(title) + ".md");
  if (!existsSync(file)) return null;
  const raw = readFileSync(file, "utf-8");
  const contentMatch = raw.match(/\n## Content\n\n([\s\S]*)/);
  if (!contentMatch) return null;
  const content = contentMatch[1].trim();
  return content.length > maxChars ? content.slice(0, maxChars) + "..." : content;
}

const VAULT_TAGS = join(__dir, "..", "vault", "Tags");

// Extract tags from a vault document's frontmatter
function getDocTags(title) {
  const file = join(VAULT_DOCS, sanitize(title) + ".md");
  if (!existsSync(file)) return [];
  const raw = readFileSync(file, "utf-8");
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return [];
  const tags = [];
  let inTags = false;
  for (const line of fmMatch[1].split("\n")) {
    if (line.match(/^tags:\s*$/)) { inTags = true; continue; }
    if (inTags) {
      const m = line.match(/^\s+-\s+(.+)/);
      if (m) tags.push(m[1].trim());
      else inTags = false;
    }
  }
  return tags;
}

// Read a tag file and extract linked document titles
function getDocsForTag(tag) {
  const file = join(VAULT_TAGS, tag + ".md");
  if (!existsSync(file)) return [];
  const raw = readFileSync(file, "utf-8");
  const docs = [];
  const re = /\[\[Documents\/([^\]|]+)/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    if (m[1] !== "Untitled") docs.push(m[1]);
  }
  return docs;
}

// Graph expansion: from seed doc titles, follow tags to find neighbor docs
// Returns array of { title, tagOverlap } sorted by overlap descending, capped at maxNeighbors
function expandByTags(seedTitles, maxSeeds = 5, maxNeighbors = 15) {
  const seeds = seedTitles.slice(0, maxSeeds);
  const seedSet = new Set(seeds.map((t) => sanitize(t)));

  // Collect all tags from seed docs
  const allTags = new Set();
  const seedTagMap = new Map(); // tag -> count of seed docs that have it
  for (const title of seeds) {
    const tags = getDocTags(title);
    for (const tag of tags) {
      allTags.add(tag);
      seedTagMap.set(tag, (seedTagMap.get(tag) || 0) + 1);
    }
  }

  // For each tag, find neighbor docs
  const neighborScores = new Map(); // sanitized title -> { title, tagOverlap }
  for (const tag of allTags) {
    const docs = getDocsForTag(tag);
    for (const docTitle of docs) {
      const key = sanitize(docTitle);
      if (seedSet.has(key)) continue; // skip seed docs
      if (!neighborScores.has(key)) {
        neighborScores.set(key, { title: docTitle, tagOverlap: 0 });
      }
      neighborScores.get(key).tagOverlap++;
    }
  }

  // Sort by tag overlap descending, cap at maxNeighbors
  return [...neighborScores.values()]
    .sort((a, b) => b.tagOverlap - a.tagOverlap)
    .slice(0, maxNeighbors);
}

// Reciprocal Rank Fusion: merge multiple ranked lists into one
// Each list is an array of { id, ...rest } in rank order
// Returns merged array sorted by RRF score descending
function rrfMerge(lists, k = 60) {
  const scores = new Map(); // id -> { rrfScore, item }
  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const item = list[rank];
      const id = item._rrfId;
      const rrfScore = 1 / (k + rank + 1);
      if (!scores.has(id)) {
        scores.set(id, { rrfScore: 0, item });
      }
      scores.get(id).rrfScore += rrfScore;
    }
  }
  return [...scores.values()]
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .map((s) => ({ ...s.item, rrfScore: s.rrfScore }));
}

// Run a prompt through Codex CLI and return the text output
function codexExec(prompt, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", ["exec", prompt], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    child.stdin.end();

    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", () => {});

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("timeout"));
    }, timeoutMs);

    child.on("close", () => {
      clearTimeout(timer);
      let text = stdout.trim();
      text = text.replace(/```(?:text)?\n[\s\S]*?RARE[\s\S]*?```\n?/g, "").trim();
      resolve(text);
    });

    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

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
    // Filter highlights by relevance — only keep scores above absolute threshold
    // Scores ~0.016 are noise floor; 0.02+ indicates genuine relevance
    const HIGHLIGHT_MIN_SCORE = 0.02;
    let kept = 0;
    let dropped = 0;
    for (const h of highlights) {
      const score = h.score || 0;
      if (score < HIGHLIGHT_MIN_SCORE) {
        dropped++;
        continue;
      }
      kept++;
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
        score,
        source: "readwise_search_highlights",
      });
    }
    toolCalls[toolCalls.length - 1].kept = kept;
    toolCalls[toolCalls.length - 1].dropped = dropped;
  } catch (e) {
    toolCalls.push({
      tool: "readwise_search_highlights",
      args: { vector_search_term: query, limit },
      error: e.message,
    });
  }

  // Graph expansion: take top 5 doc results, expand via tags, merge with RRF
  const t3Start = Date.now();
  const docResults = results.filter((r) => r.type === "document");
  const highlightResults = results.filter((r) => r.type === "highlight");
  const seedTitles = docResults.map((r) => r.title);
  const neighbors = expandByTags(seedTitles, 5, 15);
  const t3Ms = Date.now() - t3Start;

  toolCalls.push({
    tool: "graph_expansion",
    args: { seeds: Math.min(seedTitles.length, 5), tags: "vault" },
    ms: t3Ms,
    count: neighbors.length,
  });

  // Build neighbor result objects
  const neighborResults = neighbors.map((n) => ({
    type: "graph_neighbor",
    title: n.title,
    tagOverlap: n.tagOverlap,
    source: "graph_expansion",
  }));

  // RRF merge across three lists
  // Assign _rrfId to each item for dedup
  const docList = docResults.map((r) => ({ ...r, _rrfId: "doc:" + sanitize(r.title) }));
  const hlList = highlightResults.map((r) => ({ ...r, _rrfId: "hl:" + r.id }));
  const graphList = neighborResults.map((r) => ({ ...r, _rrfId: "doc:" + sanitize(r.title) }));

  const merged = rrfMerge([docList, hlList, graphList]);

  // Clean up _rrfId from output
  for (const r of merged) delete r._rrfId;

  const hasRelevantHighlights = highlightResults.length > 0;
  const hasDocuments = docResults.length > 0;
  res.json({ query, toolCalls, results: merged, shouldAnswer: hasRelevantHighlights || hasDocuments });
});

// Rerank endpoint — asks Codex to semantically reorder RRF candidates
app.post("/api/rerank", async (req, res) => {
  const { query, results } = req.body;
  if (!query) return res.status(400).json({ error: "query required" });
  if (!results || results.length === 0)
    return res.json({ results: [], ms: 0 });

  const sliced = results.slice(0, 20);
  const candidates = sliced.map((r, i) => {
    const title = r.title || "Untitled";
    const author = r.author ? ` by ${r.author}` : "";
    let snippet;
    if (r.type === "highlight") {
      snippet = (r.text || "").slice(0, 200);
    } else {
      snippet = getVaultContent(title, 200) || (r.matches || []).join(" ").slice(0, 200) || "";
    }
    return `${i}. "${title}"${author} — ${snippet}`;
  }).join("\n");

  const prompt = `You are a relevance judge. The user searched for: "${query}"

Here are ${sliced.length} candidate results. Rank them by relevance to the query. Return ONLY a comma-separated list of indices (0-based) from most relevant to least relevant. Example: 3,0,7,1,5,2,4,6

Candidates:
${candidates}

Ranking (indices only):`;

  try {
    const t0 = Date.now();
    const raw = await codexExec(prompt, 60000);
    const ms = Date.now() - t0;

    // Parse comma-separated indices from Codex output
    const indices = raw.match(/\d+/g);
    if (!indices) {
      return res.json({ results: sliced, ms, error: "Could not parse ranking" });
    }

    const seen = new Set();
    const reranked = [];
    for (const idx of indices) {
      const i = parseInt(idx, 10);
      if (i >= 0 && i < sliced.length && !seen.has(i)) {
        seen.add(i);
        reranked.push({ ...sliced[i], rerankerScore: (sliced.length - reranked.length) / sliced.length });
      }
    }
    // Append any results the LLM missed
    for (let i = 0; i < sliced.length; i++) {
      if (!seen.has(i)) {
        reranked.push(sliced[i]);
      }
    }

    res.json({ results: reranked, ms });
  } catch (e) {
    res.json({ results: sliced, ms: 0, error: e.message });
  }
});

// Answer generation endpoint — synthesizes via Codex CLI
app.post("/api/answer", async (req, res) => {
  const { query, results } = req.body;
  if (!query) return res.status(400).json({ error: "query required" });
  if (!results || results.length === 0)
    return res.json({ answer: "No sources to synthesize from." });

  const citeLabel = (i) => String.fromCharCode(97 + i);
  const sliced = results.slice(0, 15);
  const context = sliced
    .map((r, i) => {
      const title = r.title || "Untitled";
      const author = r.author ? ` by ${r.author}` : "";
      const maxChars = i < 5 ? 2000 : 500;
      let text;
      if (r.type === "highlight") {
        text = r.text || "";
      } else {
        text = getVaultContent(title, maxChars) || (r.matches || []).join("\n") || "";
      }
      return `[${citeLabel(i)}] "${title}"${author}\n${text}`;
    })
    .join("\n\n");

  const prompt = `You are a research assistant. The user asked: "${query}"

Here are relevant excerpts from their Readwise library:

${context}

Write a concise, well-structured answer to the user's question based on these sources. Cite sources using [a], [b], [c], etc. If the sources don't fully answer the question, say so. Keep it under 300 words.`;

  try {
    const t0 = Date.now();
    const answer = await codexExec(prompt);
    const ms = Date.now() - t0;
    res.json({ answer, ms });
  } catch (e) {
    res.json({ answer: null, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`http://localhost:${PORT}`);
});
