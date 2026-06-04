/**
 * server.mjs — Local development server only.
 * Vercel uses api/*.mjs functions instead of this file.
 * Run with: node server.mjs
 */

import http from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import { fetchFeed, fetchPibArticle, extractArticle, normalizeArticleKey } from "./lib/engine.mjs";

const root      = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(root, "public");
const dbFile    = join(root, "db.json");
const port      = Number(process.env.PORT || 4173);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".js":   "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml"
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (url.pathname === "/api/scan" && req.method === "POST") {
      await handleScan(req, res); return;
    }
    if (url.pathname === "/api/article" && req.method === "GET") {
      await handleArticle(url, res); return;
    }
    if (url.pathname === "/api/db") {
      await handleDb(req, res); return;
    }
    if (url.pathname === "/api/health") {
      sendJson(res, 200, { status: "LOCAL_DEV", message: "Running locally — Redis not used, db.json is the store." }); return;
    }
    if (url.pathname === "/health") {
      sendJson(res, 200, { ok: true }); return;
    }

    await serveStatic(url.pathname, res);
  } catch (error) {
    sendJson(res, 500, { error: "Unexpected server error", detail: String(error?.message || error) });
  }
});

server.listen(port, () => {
  console.log(`CA Engine (local) → http://localhost:${port}`);
});

// ─── Route handlers ───────────────────────────────────────────────────────────

async function handleScan(req, res) {
  const body      = await readJsonBody(req);
  const feeds     = Array.isArray(body.feeds) ? body.feeds : [];
  const cleanFeeds = feeds.map(f => String(f || "").trim()).filter(Boolean).slice(0, 25);

  if (!cleanFeeds.length) {
    sendJson(res, 400, { error: "Add at least one RSS feed URL before scanning." }); return;
  }

  const results    = await Promise.allSettled(cleanFeeds.map(fetchFeed));
  const articles   = [];
  const feedResults = [];
  const seen       = new Set();

  results.forEach((result, index) => {
    const feedUrl = cleanFeeds[index];
    if (result.status === "rejected") {
      feedResults.push({ url: feedUrl, ok: false, error: result.reason?.message || "Could not read feed" });
      return;
    }
    feedResults.push({ url: feedUrl, ok: true, title: result.value.title, count: result.value.items.length });
    for (const item of result.value.items) {
      const key = normalizeArticleKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      articles.push({ ...item, feedUrl, feedTitle: result.value.title });
    }
  });

  articles.sort((a, b) => (Date.parse(b.publishedAt || "") || 0) - (Date.parse(a.publishedAt || "") || 0));
  sendJson(res, 200, { scannedAt: new Date().toISOString(), feeds: feedResults, articles });
}

async function handleArticle(url, res) {
  const articleUrl = String(url.searchParams.get("url") || "").trim();
  if (!articleUrl) { sendJson(res, 400, { error: "Missing article URL" }); return; }

  let parsed;
  try { parsed = new URL(articleUrl); } catch { sendJson(res, 400, { error: "Invalid article URL" }); return; }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    sendJson(res, 400, { error: "Only HTTP and HTTPS article URLs are supported" }); return;
  }

  if (parsed.hostname.includes("pib.gov.in")) {
    const pibResult = await fetchPibArticle(parsed, articleUrl);
    if (pibResult) { sendJson(res, 200, pibResult); return; }
  }

  const response = await fetch(parsed, {
    headers: { "accept": "text/html,application/xhtml+xml,*/*;q=0.8", "user-agent": "Shivam Shaurya Current Affairs Engine/0.1" },
    redirect: "follow"
  });
  if (!response.ok) { sendJson(res, response.status, { error: `Article returned HTTP ${response.status}` }); return; }

  const html = await response.text();
  sendJson(res, 200, extractArticle(html, response.url || articleUrl));
}

async function handleDb(req, res) {
  // Local dev: read/write db.json as a file-backed KV store
  if (req.method === "GET") {
    try {
      const raw = await readFile(dbFile, "utf8");
      sendJson(res, 200, JSON.parse(raw));
    } catch {
      sendJson(res, 200, {}); // file doesn't exist yet
    }
    return;
  }
  if (req.method === "POST") {
    const body = await readJsonBody(req);
    await writeFile(dbFile, JSON.stringify(body, null, 2), "utf8");
    sendJson(res, 200, { ok: true });
    return;
  }
  sendJson(res, 405, { error: "Method not allowed" });
}

// ─── Static file serving ──────────────────────────────────────────────────────

async function serveStatic(pathname, res) {
  const safePath = pathname === "/" ? "/index.html" : decodeURIComponent(pathname);
  const filePath = normalize(join(publicDir, safePath));
  if (!filePath.startsWith(publicDir)) { sendText(res, 403, "Forbidden"); return; }

  try {
    const data = await readFile(filePath);
    res.writeHead(200, { "content-type": mimeTypes[extname(filePath)] || "application/octet-stream" });
    res.end(data);
  } catch {
    sendText(res, 404, "Not found");
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => {
      data += chunk;
      if (data.length > 5_000_000) { reject(new Error("Request body too large")); req.destroy(); }
    });
    req.on("end",   () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error("Invalid JSON")); } });
    req.on("error", reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

function sendText(res, status, text) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}
