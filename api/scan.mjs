// api/scan.mjs — Vercel serverless function for POST /api/scan
import { fetchFeed, normalizeArticleKey } from "../lib/engine.mjs";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const body      = req.body ?? {};
  const feeds     = Array.isArray(body.feeds) ? body.feeds : [];
  const cleanFeeds = feeds.map(f => String(f || "").trim()).filter(Boolean).slice(0, 25);

  if (!cleanFeeds.length) {
    return res.status(400).json({ error: "Add at least one RSS feed URL before scanning." });
  }

  const results     = await Promise.allSettled(cleanFeeds.map(fetchFeed));
  const articles    = [];
  const feedResults = [];
  const seen        = new Set();

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
  return res.status(200).json({ scannedAt: new Date().toISOString(), feeds: feedResults, articles });
}
