// api/article.mjs — Vercel serverless function for GET /api/article
// PIB articles are opened in a headless Chromium browser for reliable
// English content extraction. All other articles use a plain fetch.

import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";
import { extractArticle, fetchPibArticle } from "../lib/engine.mjs";

// ─── Headless PIB fetcher ────────────────────────────────────────────────────

async function fetchPibHeadless(prid) {
  let browser;
  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();

    // Block images, media, fonts, CSS — we only need the DOM text
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      if (["image", "media", "font", "stylesheet"].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    // Identify as an English-language browser
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36"
    );

    // Navigate directly to the English content endpoint
    const contentUrl = `https://pib.gov.in/PressReleaseContent.aspx?PRID=${encodeURIComponent(prid)}&Lang=1`;
    const navResponse = await page.goto(contentUrl, {
      waitUntil: "domcontentloaded",
      timeout: 7000,
    });

    if (!navResponse?.ok()) return null;

    const html = await page.content();
    return extractArticle(html, contentUrl);
  } finally {
    if (browser) await browser.close();
  }
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const articleUrl = String(req.query?.url || "").trim();
  if (!articleUrl) return res.status(400).json({ error: "Missing article URL" });

  let parsed;
  try { parsed = new URL(articleUrl); } catch {
    return res.status(400).json({ error: "Invalid article URL" });
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return res.status(400).json({ error: "Only HTTP and HTTPS article URLs are supported" });
  }

  // ── PIB: headless browser → fetch fallback ──────────────────────────────
  if (parsed.hostname.includes("pib.gov.in")) {
    const prid = parsed.searchParams.get("PRID") || parsed.searchParams.get("prid");

    if (prid) {
      // Primary: headless Chromium (handles sessions, language negotiation)
      try {
        const result = await fetchPibHeadless(prid);
        if (result?.wordCount >= 30) {
          result.originalUrl = articleUrl;
          return res.status(200).json(result);
        }
      } catch (err) {
        console.warn("Headless PIB failed, falling back to fetch:", err.message);
      }

      // Fallback: plain fetch across multiple PIB URL patterns
      const fallback = await fetchPibArticle(parsed, articleUrl).catch(() => null);
      if (fallback) return res.status(200).json(fallback);
    }

    return res.status(422).json({ error: "Could not extract content from this PIB article." });
  }

  // ── All other articles: plain fetch ────────────────────────────────────
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    const response = await fetch(parsed, {
      headers: {
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "user-agent": "Shivam Shaurya Current Affairs Engine/0.1"
      },
      redirect: "follow",
      signal: controller.signal
    });
    clearTimeout(timer);

    if (!response.ok) {
      return res.status(response.status).json({ error: `Article returned HTTP ${response.status}` });
    }
    const html = await response.text();
    return res.status(200).json(extractArticle(html, response.url || articleUrl));
  } catch (err) {
    clearTimeout(timer);
    return res.status(504).json({ error: err.name === "AbortError" ? "Article fetch timed out" : String(err.message) });
  }
}
