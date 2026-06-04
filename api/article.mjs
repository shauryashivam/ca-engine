// api/article.mjs — Vercel serverless function for GET /api/article
import { extractArticle, fetchPibArticle } from "../lib/engine.mjs";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const articleUrl = String(req.query?.url || "").trim();
  if (!articleUrl) {
    return res.status(400).json({ error: "Missing article URL" });
  }

  let parsed;
  try { parsed = new URL(articleUrl); } catch {
    return res.status(400).json({ error: "Invalid article URL" });
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return res.status(400).json({ error: "Only HTTP and HTTPS article URLs are supported" });
  }

  if (parsed.hostname.includes("pib.gov.in")) {
    const pibResult = await fetchPibArticle(parsed, articleUrl);
    if (pibResult) return res.status(200).json(pibResult);
  }

  const response = await fetch(parsed, {
    headers: {
      "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "user-agent": "Shivam Shaurya Current Affairs Engine/0.1"
    },
    redirect: "follow"
  });

  if (!response.ok) {
    return res.status(response.status).json({ error: `Article returned HTTP ${response.status}` });
  }

  const html = await response.text();
  return res.status(200).json(extractArticle(html, response.url || articleUrl));
}
