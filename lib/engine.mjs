/**
 * lib/engine.mjs
 * Shared RSS parsing and article extraction utilities.
 * Imported by both server.mjs (local dev) and Vercel API functions.
 * No Node-specific APIs — pure fetch + regex, works in any runtime.
 */

export const RICH_BLOCK_TAGS  = new Set(["p","h1","h2","h3","h4","h5","h6","ul","ol","li","blockquote","pre","figure","figcaption","br","hr","table","thead","tbody","tr","th","td"]);
export const RICH_INLINE_TAGS = new Set(["strong","em","b","i","u","s","code","mark","small","sup","sub","span"]);

// ─── Feed fetching & parsing ──────────────────────────────────────────────────

export async function fetchFeed(feedUrl) {
  let parsed;
  try { parsed = new URL(feedUrl); } catch { throw new Error("Invalid URL"); }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Only HTTP and HTTPS feeds are supported");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000); // 8s timeout per feed
  try {
    const response = await fetch(parsed, {
      headers: {
        "accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
        "user-agent": "Shivam Shaurya Current Affairs Engine/0.1"
      },
      redirect: "follow",
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!response.ok) throw new Error(`Feed returned HTTP ${response.status}`);
    const xml = await response.text();
    return parseFeed(xml, feedUrl);
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

export function parseFeed(xml, feedUrl) {
  const feedTitle = firstText(xml, "channel title") || firstText(xml, "feed title") || hostFromUrl(feedUrl);
  const rssItems  = blocks(xml, "item").map(parseRssItem);
  const atomItems = blocks(xml, "entry").map(parseAtomEntry);
  const items = [...rssItems, ...atomItems]
    .filter(item => (item.title || item.link) && !isDevanagari(item.title)) // drop Hindi-only feed items
    .slice(0, 80);
  return { title: cleanText(feedTitle), items };
}

function parseRssItem(block) {
  return {
    id:          cleanText(firstText(block, "guid"))    || cleanText(firstText(block, "link")) || cleanText(firstText(block, "title")),
    title:       cleanText(firstText(block, "title")),
    link:        cleanText(firstText(block, "link")),
    summary:     cleanText(firstText(block, "description") || firstText(block, "content:encoded")),
    author:      cleanText(firstText(block, "dc:creator") || firstText(block, "author")),
    publishedAt: cleanText(firstText(block, "pubDate")   || firstText(block, "published") || firstText(block, "updated"))
  };
}

function parseAtomEntry(block) {
  const href = attrFromTag(block, "link", "href");
  return {
    id:          cleanText(firstText(block, "id")) || href || cleanText(firstText(block, "title")),
    title:       cleanText(firstText(block, "title")),
    link:        cleanText(href || firstText(block, "link")),
    summary:     cleanText(firstText(block, "summary") || firstText(block, "content")),
    author:      cleanText(firstText(block, "name")    || firstText(block, "author")),
    publishedAt: cleanText(firstText(block, "published") || firstText(block, "updated"))
  };
}

// ─── Article fetching ─────────────────────────────────────────────────────────

export async function fetchPibArticle(parsedUrl, originalUrl) {
  const prid = parsedUrl.searchParams.get("PRID") || parsedUrl.searchParams.get("prid");
  if (!prid) return null;

  const candidates = [
    `https://pib.gov.in/PressReleaseContent.aspx?PRID=${encodeURIComponent(prid)}&Lang=1`,
    `https://pib.gov.in/newsite/PrintRelease.aspx?relid=${encodeURIComponent(prid)}`,
    `https://pib.gov.in/Pressreleaseshare.aspx?PRID=${encodeURIComponent(prid)}&Lang=1`,
    `https://pib.gov.in/PressRelease.aspx?PRID=${encodeURIComponent(prid)}`,
  ];

  const headers = {
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "accept-language": "en-US,en;q=0.9",
    "referer": "https://pib.gov.in/"
  };

  for (const candidateUrl of candidates) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000); // 5s per attempt
    try {
      const response = await fetch(candidateUrl, { headers, redirect: "follow", signal: controller.signal });
      clearTimeout(timer);
      if (!response.ok) continue;

      const html   = await response.text();
      const result = extractArticle(html, response.url || candidateUrl);

      // Skip if content is primarily Devanagari (Hindi-only press release, no English version)
      if (result.wordCount >= 30 && !isDevanagari(result.text)) {
        result.originalUrl = originalUrl;
        return result;
      }
    } catch (err) {
      clearTimeout(timer);
      // AbortError = timed out; any other error = network/parse issue — try next candidate
    }
  }
  return null; // No English content found — UI falls back to RSS summary
}

// ─── Article extraction ───────────────────────────────────────────────────────

export function extractArticle(html, sourceUrl) {
  const title       = cleanText(firstText(html, "title")  || metaContent(html, "og:title")       || metaContent(html, "twitter:title"));
  const description = cleanText(metaContent(html, "description") || metaContent(html, "og:description") || metaContent(html, "twitter:description"));
  const source      = hostFromUrl(sourceUrl);

  const cleaned = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi,   " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi,       " ")
    .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, " ")
    .replace(/<header\b[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer\b[\s\S]*?<\/footer>/gi, " ")
    .replace(/<nav\b[\s\S]*?<\/nav>/gi,       " ")
    .replace(/<aside\b[\s\S]*?<\/aside>/gi,   " ");

  const articleBlocks = [
    ...blocks(cleaned, "article"),
    ...blocksByClass(cleaned, "story"),
    ...blocksByClass(cleaned, "article"),
    ...blocksByClass(cleaned, "content")
  ];
  const candidates = articleBlocks.length ? articleBlocks : [cleaned];
  const paragraphs  = bestParagraphs(candidates);
  const text        = paragraphs.join("\n\n");

  return {
    url:         sourceUrl,
    source,
    title,
    description,
    text,
    html:        buildRichHtml(html),
    paragraphs,
    wordCount:   text ? text.split(/\s+/).filter(Boolean).length : 0,
    extractedAt: new Date().toISOString()
  };
}

export function buildRichHtml(html) {
  let stripped = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi,   "")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi,       "")
    .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, "")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, "")
    .replace(/<header\b[\s\S]*?<\/header>/gi, "")
    .replace(/<footer\b[\s\S]*?<\/footer>/gi, "")
    .replace(/<nav\b[\s\S]*?<\/nav>/gi,       "")
    .replace(/<aside\b[\s\S]*?<\/aside>/gi,   "")
    .replace(/<form\b[\s\S]*?<\/form>/gi,     "");

  const candidates = [
    ...blocks(stripped, "article"),
    ...blocksByClass(stripped, "story-body"),
    ...blocksByClass(stripped, "article-body"),
    ...blocksByClass(stripped, "article-content"),
    ...blocksByClass(stripped, "story-content"),
    ...blocksByClass(stripped, "article-text"),
    ...blocksByClass(stripped, "content-body"),
    ...blocksByClass(stripped, "story"),
    ...blocksByClass(stripped, "article"),
    ...blocksByClass(stripped, "content")
  ];

  const best   = candidates.map(c => ({ html: c, score: (c.match(/<p\b/gi) || []).length })).sort((a, b) => b.score - a.score)[0];
  const source = best && best.score > 0 ? best.html : stripped;

  const sanitized = source.replace(/<(\/?)([a-z][\w-]*)(\s[^>]*)?\/?>/gi, (match, slash, rawTag, attrs) => {
    const tag = rawTag.toLowerCase();

    if (RICH_BLOCK_TAGS.has(tag) || RICH_INLINE_TAGS.has(tag)) return `<${slash}${tag}>`;

    if (tag === "a") {
      if (slash) return "</a>";
      const href = (attrs || "").match(/href=["']([^"']{4,2048})["']/i)?.[1];
      if (href) {
        try {
          const u = new URL(href);
          if (u.protocol === "http:" || u.protocol === "https:") return `<a href="${u.href.replace(/"/g, "&quot;")}" target="_blank" rel="noopener noreferrer">`;
        } catch {}
      }
      return "";
    }

    if (tag === "img") {
      const src = (attrs || "").match(/src=["']([^"']{4,2048})["']/i)?.[1];
      const alt = (attrs || "").match(/alt=["']([^"']{0,200})["']/i)?.[1] || "";
      if (src) {
        try {
          const u = new URL(src);
          if (u.protocol === "http:" || u.protocol === "https:") return `<img src="${u.href.replace(/"/g, "&quot;")}" alt="${alt.replace(/"/g, "&quot;")}" loading="lazy">`;
        } catch {}
      }
      return "";
    }

    return slash ? "" : "";
  });

  return sanitized.replace(/<(p|li|h[1-6])>\s*<\/\1>/gi, "").replace(/\s{3,}/g, "  ").trim();
}

// ─── HTML helpers ─────────────────────────────────────────────────────────────

export function normalizeArticleKey(item) {
  return String(item.id || item.link || item.title || "").trim().toLowerCase();
}

export function hostFromUrl(value) {
  try { return new URL(value).hostname.replace(/^www\./, ""); } catch { return "RSS Feed"; }
}

function metaContent(html, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta\\b[^>]*(?:name|property)=["']${escaped}["'][^>]*content=["']([^"']*)["'][^>]*>`, "i"),
    new RegExp(`<meta\\b[^>]*content=["']([^"']*)["'][^>]*(?:name|property)=["']${escaped}["'][^>]*>`, "i")
  ];
  for (const p of patterns) { const m = html.match(p); if (m) return m[1]; }
  return "";
}

function blocksByClass(html, className) {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<(?:article|main|section|div)\\b[^>]*(?:class|id)=["'][^"']*${escaped}[^"']*["'][^>]*>([\\s\\S]*?)<\\/(?:article|main|section|div)>`, "gi");
  return [...html.matchAll(pattern)].map(m => m[1]);
}

function bestParagraphs(candidates) {
  const scored = candidates.map(candidate => {
    const paragraphs = [...candidate.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
      .map(m => cleanText(m[1]))
      .filter(p => p.length > 45 && !isBoilerplate(p));
    const score = paragraphs.reduce((t, p) => t + p.length, 0);
    return { paragraphs, score };
  }).sort((a, b) => b.score - a.score);

  const paragraphs = scored[0]?.paragraphs || [];
  if (paragraphs.length) return paragraphs.slice(0, 80);

  return cleanText(candidates.join(" "))
    .split(/(?<=[.!?])\s+(?=[A-Z])/)
    .map(p => p.trim())
    .filter(p => p.length > 70 && !isBoilerplate(p))
    .slice(0, 30);
}

function isBoilerplate(text) {
  return /subscribe|sign in|sign up|advertisement|cookie|privacy policy|terms of use|read more|follow us|share this/i.test(text);
}

function blocks(xml, tag) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}>`, "gi");
  return [...xml.matchAll(pattern)].map(m => m[1]);
}

function firstText(xml, tagPath) {
  const tags = tagPath.split(" ");
  let scope = xml;
  for (const tag of tags) {
    const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match   = scope.match(new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}>`, "i"));
    if (!match) return "";
    scope = match[1];
  }
  return scope;
}

function attrFromTag(xml, tag, attr) {
  const eTag  = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const eAttr = attr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = xml.match(new RegExp(`<${eTag}\\b[^>]*\\s${eAttr}=["']([^"']+)["'][^>]*>`, "i"));
  return match?.[1] || "";
}

function cleanText(value) {
  return decodeEntities(String(value || ""))
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(value) {
  return value
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"").replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g,     (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([a-f0-9]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

// Returns true if the text is predominantly Devanagari (Hindi/Sanskrit).
// Used to skip Hindi-only PIB press releases and filter RSS feed items.
function isDevanagari(text) {
  if (!text) return false;
  const devChars   = (text.match(/[ऀ-ॿ]/g) || []).length;
  const totalChars = text.replace(/\s/g, "").length;
  return totalChars > 0 && devChars / totalChars > 0.15;
}
