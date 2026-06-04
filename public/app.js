const DEFAULT_FEEDS = [
  "https://www.thehindu.com/news/national/feeder/default.rss",
  "https://indianexpress.com/section/india/feed/",
  "https://pib.gov.in/RssMain.aspx?ModId=6&Lang=1&Regid=3"
];

const DEFAULT_THEMES = [
  { name: "Polity and Governance", keywords: "constitution, parliament, bill, act, court, supreme court, election, governance, federalism, rights, policy, scheme, ministry" },
  { name: "Economy", keywords: "gdp, inflation, rbi, bank, fiscal, budget, tax, trade, export, import, market, employment, growth, finance" },
  { name: "International Relations", keywords: "bilateral, foreign, global, un, g20, brics, treaty, diplomacy, border, china, pakistan, usa, russia, neighbourhood" },
  { name: "Environment and Ecology", keywords: "climate, forest, biodiversity, pollution, wildlife, conservation, environment, renewable, carbon, disaster, river, water" },
  { name: "Science and Technology", keywords: "space, isro, ai, digital, cyber, technology, research, vaccine, biotech, semiconductor, quantum, data" },
  { name: "Society and Social Justice", keywords: "health, education, women, child, poverty, caste, tribal, migration, inequality, welfare, nutrition, social" },
  { name: "Security", keywords: "defence, security, terrorism, insurgency, cyber attack, army, navy, air force, border, police, drone" }
];

let pendingReaderSelection = "";
let dbSaveTimer = null;

const state = {
  feeds:              load("cae.feeds",      DEFAULT_FEEDS),
  themes:             load("cae.themes",     DEFAULT_THEMES),
  seen:               load("cae.seen",       []),
  articles:           load("cae.articles",   []),
  articleText:        load("cae.articleText",{}),
  highlights:         load("cae.highlights", {}),
  notes:              load("cae.notes",      {}),
  dismissed:          load("cae.dismissed",  []),   // array of article keys
  journal:            load("cae.journal",    {}),   // key → journal entry snapshot
  activeTab:          "articles",
  selectedTheme:      "All",
  selectedSource:     "All Sources",
  selectedArticleKey: localStorage.getItem("cae.selectedArticleKey") || "",
  search:             "",
  lastScan:           localStorage.getItem("cae.lastScan") || "",
  showDismissed:      false
};

const loadingArticleKeys = new Set();

const els = {
  articlesView:       document.querySelector("#articles-view"),
  settingsView:       document.querySelector("#settings-view"),
  highlightsView:     document.querySelector("#highlights-view"),
  journalView:        document.querySelector("#journal-view"),
  tabButtons:         document.querySelectorAll("[data-tab]"),
  feedForm:           document.querySelector("#feed-form"),
  feedUrl:            document.querySelector("#feed-url"),
  feedList:           document.querySelector("#feed-list"),
  themeForm:          document.querySelector("#theme-form"),
  themeName:          document.querySelector("#theme-name"),
  themeKeywords:      document.querySelector("#theme-keywords"),
  themeList:          document.querySelector("#theme-list"),
  scanButton:         document.querySelector("#scan-button"),
  scanStatus:         document.querySelector("#scan-status"),
  articleList:        document.querySelector("#article-list"),
  previewPane:        document.querySelector("#preview-pane"),
  themeFilters:       document.querySelector("#theme-filters"),
  sourceFilter:       document.querySelector("#source-filter"),
  search:             document.querySelector("#search"),
  articleCount:       document.querySelector("#article-count"),
  newCount:           document.querySelector("#new-count"),
  feedCount:          document.querySelector("#feed-count"),
  themeCount:         document.querySelector("#theme-count"),
  settingsFeedCount:  document.querySelector("#settings-feed-count"),
  settingsThemeCount: document.querySelector("#settings-theme-count"),
  lastScan:           document.querySelector("#last-scan"),
  clearArticles:      document.querySelector("#clear-articles")
};

render();
loadFromDb(); // sync from cloud DB in the background

els.tabButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    state.activeTab = btn.dataset.tab;
    renderTabs();
    if (state.activeTab === "highlights") renderHighlightsView();
    if (state.activeTab === "journal")    renderJournalView();
  });
});

els.feedForm.addEventListener("submit", (e) => { e.preventDefault(); addFeed(els.feedUrl.value); });
els.themeForm.addEventListener("submit", (e) => { e.preventDefault(); addTheme(els.themeName.value, els.themeKeywords.value); });
els.scanButton.addEventListener("click", scanFeeds);
els.search.addEventListener("input", (e) => { state.search = e.target.value; renderArticles(); });
els.sourceFilter.addEventListener("change", (e) => { state.selectedSource = e.target.value; renderArticles(); });
els.clearArticles.addEventListener("click", () => {
  state.articles = []; state.seen = []; state.selectedArticleKey = "";
  persist(); render();
});

document.addEventListener("mousedown", (e) => {
  const toolbar = document.querySelector("#selection-toolbar");
  if (toolbar && !toolbar.contains(e.target)) toolbar.style.display = "none";
});

// ─── Feed / Theme management ──────────────────────────────────────────────────

function addFeed(value) {
  const url = value.trim();
  try {
    const p = new URL(url);
    if (!["http:","https:"].includes(p.protocol)) throw new Error();
  } catch { setStatus("Enter a valid HTTP or HTTPS RSS URL.", "error"); return; }
  if (state.feeds.includes(url)) { setStatus("That feed is already in the list.", "error"); return; }
  state.feeds.unshift(url);
  els.feedUrl.value = "";
  persist(); render();
}

function removeFeed(url) {
  state.feeds = state.feeds.filter(f => f !== url);
  if (!sources().includes(state.selectedSource)) state.selectedSource = "All Sources";
  persist(); render();
}

function addTheme(nameValue, keywordValue) {
  const name = nameValue.trim(), keywords = keywordValue.trim();
  if (!name || !keywords) { setStatus("Add a theme name and at least one keyword.", "error"); return; }
  const existing = state.themes.find(t => t.name.toLowerCase() === name.toLowerCase());
  if (existing) { existing.keywords = keywords; } else { state.themes.push({ name, keywords }); }
  els.themeName.value = ""; els.themeKeywords.value = "";
  persist(); render();
}

function removeTheme(name) {
  state.themes = state.themes.filter(t => t.name !== name);
  if (state.selectedTheme === name) state.selectedTheme = "All";
  persist(); render();
}

// ─── Scan ─────────────────────────────────────────────────────────────────────

async function scanFeeds() {
  if (!state.feeds.length) { setStatus("Add at least one RSS feed before scanning.", "error"); return; }
  els.scanButton.disabled = true;
  setStatus("Scanning feeds...", "loading");
  try {
    const resp = await fetch("/api/scan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ feeds: state.feeds })
    });
    const payload = await resp.json();
    if (!resp.ok) throw new Error(payload.error || "Scan failed");

    const before = new Set(state.seen);
    const incoming = payload.articles.map(a => {
      const tagged = tagArticle(a);
      const key = articleKey(tagged);
      return { ...tagged, key, isNew: !before.has(key), scannedAt: payload.scannedAt };
    });

    const byKey = new Map(state.articles.map(a => [a.key || articleKey(a), a]));
    for (const a of incoming) byKey.set(a.key, a);

    state.articles = [...byKey.values()].sort(sortByDate).slice(0, 500);
    state.seen = [...new Set([...state.seen, ...incoming.map(a => a.key)])].slice(-1000);
    if (!state.selectedArticleKey && state.articles.length)
      state.selectedArticleKey = state.articles[0].key || articleKey(state.articles[0]);

    state.lastScan = payload.scannedAt;
    localStorage.setItem("cae.lastScan", state.lastScan);
    persist();

    const newItems = incoming.filter(a => a.isNew).length;
    const failed   = payload.feeds.filter(f => !f.ok).length;
    setStatus(`Scan complete. ${newItems} new article${newItems === 1 ? "" : "s"} found.${failed ? ` ${failed} feed${failed>1?"s":""} failed.` : ""}`, failed ? "warn" : "ok");
    render();
  } catch (err) {
    setStatus(err.message || "Could not scan feeds.", "error");
  } finally {
    els.scanButton.disabled = false;
  }
}

function tagArticle(article) {
  const text = `${article.title||""} ${article.summary||""}`.toLowerCase();
  const scores = state.themes.map(theme => {
    const words = theme.keywords.split(",").map(w => w.trim().toLowerCase()).filter(Boolean);
    const score = words.reduce((t, w) => t + (text.includes(w) ? 1 : 0), 0);
    return { theme: theme.name, score, matched: words.filter(w => text.includes(w)).slice(0, 5) };
  }).sort((a, b) => b.score - a.score);
  const best = scores[0];
  return {
    ...article,
    theme: best && best.score > 0 ? best.theme : "Needs Review",
    matchedKeywords: best && best.score > 0 ? best.matched : [],
    confidence: best && best.score > 0 ? Math.min(95, 45 + best.score * 15) : 25
  };
}

// ─── Render controllers ───────────────────────────────────────────────────────

function render() {
  renderTabs();
  renderFeeds();
  renderThemes();
  renderFilters();
  renderSourceFilter();
  renderArticles();
  els.feedCount.textContent          = state.feeds.length;
  els.themeCount.textContent         = state.themes.length;
  els.settingsFeedCount.textContent  = state.feeds.length;
  els.settingsThemeCount.textContent = state.themes.length;
  els.lastScan.textContent           = state.lastScan ? formatDate(state.lastScan) : "Not scanned yet";
}

function renderTabs() {
  els.tabButtons.forEach(btn => btn.classList.toggle("active", btn.dataset.tab === state.activeTab));
  els.articlesView.classList.toggle("active-view",   state.activeTab === "articles");
  els.settingsView.classList.toggle("active-view",   state.activeTab === "settings");
  els.highlightsView.classList.toggle("active-view", state.activeTab === "highlights");
  els.journalView.classList.toggle("active-view",    state.activeTab === "journal");
}

function renderFeeds() {
  els.feedList.innerHTML = state.feeds.map(feed => `
    <li>
      <span title="${escapeHtml(feed)}">${escapeHtml(feed)}</span>
      <button class="icon-button danger" type="button" aria-label="Remove feed" data-remove-feed="${escapeHtml(feed)}">x</button>
    </li>
  `).join("");
  els.feedList.querySelectorAll("[data-remove-feed]").forEach(btn =>
    btn.addEventListener("click", () => removeFeed(btn.dataset.removeFeed)));
}

function renderThemes() {
  els.themeList.innerHTML = state.themes.map(theme => `
    <li>
      <div>
        <strong>${escapeHtml(theme.name)}</strong>
        <small>${escapeHtml(theme.keywords)}</small>
      </div>
      <button class="icon-button danger" type="button" aria-label="Remove theme" data-remove-theme="${escapeHtml(theme.name)}">x</button>
    </li>
  `).join("");
  els.themeList.querySelectorAll("[data-remove-theme]").forEach(btn =>
    btn.addEventListener("click", () => removeTheme(btn.dataset.removeTheme)));
}

function renderFilters() {
  const themes = ["All", "New", "Needs Review", ...state.themes.map(t => t.name)];
  els.themeFilters.innerHTML = themes.map(theme => `
    <button class="${state.selectedTheme === theme ? "active" : ""}" type="button" data-theme="${escapeHtml(theme)}">${escapeHtml(theme)}</button>
  `).join("");
  if (state.dismissed.length) {
    els.themeFilters.innerHTML += `
      <button class="filter-dismissed-btn ${state.showDismissed ? "active-warn" : ""}" type="button" id="toggle-dismissed">
        ${state.showDismissed ? "Hide" : "Show"} dismissed (${state.dismissed.length})
      </button>`;
  }
  els.themeFilters.querySelectorAll("[data-theme]").forEach(btn =>
    btn.addEventListener("click", () => {
      state.selectedTheme = btn.dataset.theme;
      renderFilters(); renderArticles();
    }));
  document.querySelector("#toggle-dismissed")?.addEventListener("click", () => {
    state.showDismissed = !state.showDismissed;
    renderFilters(); renderArticles();
  });
}

function renderSourceFilter() {
  const options = ["All Sources", ...sources()];
  if (!options.includes(state.selectedSource)) state.selectedSource = "All Sources";
  els.sourceFilter.innerHTML = options.map(s => `
    <option value="${escapeHtml(s)}" ${s === state.selectedSource ? "selected" : ""}>${escapeHtml(s)}</option>
  `).join("");
}

function renderArticles() {
  const query = state.search.trim().toLowerCase();
  const filtered = state.articles.filter(article => {
    const key = article.key || articleKey(article);
    const isDismissed = state.dismissed.includes(key);
    if (isDismissed && !state.showDismissed) return false;

    const themeMatch =
      state.selectedTheme === "All" ||
      (state.selectedTheme === "New" && article.isNew) ||
      article.theme === state.selectedTheme;
    const sourceMatch = state.selectedSource === "All Sources" || sourceName(article) === state.selectedSource;
    const searchMatch = !query || `${article.title} ${article.summary} ${article.feedTitle} ${article.theme}`.toLowerCase().includes(query);
    return themeMatch && sourceMatch && searchMatch;
  });

  els.articleCount.textContent = filtered.length;
  els.newCount.textContent     = state.articles.filter(a => a.isNew && !state.dismissed.includes(a.key || articleKey(a))).length;

  if (filtered.length && !filtered.some(a => (a.key || articleKey(a)) === state.selectedArticleKey)) {
    state.selectedArticleKey = filtered[0].key || articleKey(filtered[0]);
    localStorage.setItem("cae.selectedArticleKey", state.selectedArticleKey);
  }

  if (!filtered.length) {
    els.articleList.innerHTML = `
      <div class="empty">
        <strong>No articles here yet.</strong>
        <span>Scan feeds or adjust the current filters.</span>
      </div>`;
    renderPreview(null); return;
  }

  els.articleList.innerHTML = filtered.map(article => {
    const key = article.key || articleKey(article);
    const isDismissed = state.dismissed.includes(key);
    const inJournal   = !!state.journal[key];
    return `
    <article class="article-card ${article.isNew ? "new" : ""} ${key === state.selectedArticleKey ? "selected" : ""} ${isDismissed ? "dismissed" : ""}"
             tabindex="0" role="button" data-article-key="${escapeHtml(key)}">
      <button class="card-dismiss-btn" type="button" title="${isDismissed ? "Restore" : "Mark irrelevant"}"
              data-dismiss-key="${escapeHtml(key)}">${isDismissed ? "↩" : "✕"}</button>
      ${inJournal ? `<span class="card-star" title="In weekly journal">★</span>` : ""}
      <div class="article-topline">
        <span>${escapeHtml(sourceName(article))}</span>
        <span>${article.publishedAt ? escapeHtml(formatDate(article.publishedAt)) : "Date unavailable"}</span>
      </div>
      <h2>${escapeHtml(article.title || "Untitled article")}</h2>
      <p>${escapeHtml(article.summary || "No summary available from this feed.")}</p>
      <div class="article-meta">
        <span class="tag">${escapeHtml(article.theme)}</span>
        <span>${article.confidence}% match</span>
        ${article.isNew ? "<span>New</span>" : ""}
      </div>
      ${article.matchedKeywords?.length ? `<div class="keywords">${article.matchedKeywords.map(w => `<span>${escapeHtml(w)}</span>`).join("")}</div>` : ""}
    </article>`;
  }).join("");

  els.articleList.querySelectorAll("[data-article-key]").forEach(card => {
    card.addEventListener("click", () => selectArticle(card.dataset.articleKey));
    card.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectArticle(card.dataset.articleKey); }
    });
  });

  els.articleList.querySelectorAll("[data-dismiss-key]").forEach(btn => {
    btn.addEventListener("click", e => { e.stopPropagation(); toggleDismiss(btn.dataset.dismissKey); });
  });

  renderPreview(state.articles.find(a => (a.key || articleKey(a)) === state.selectedArticleKey) || filtered[0]);
}

// ─── Preview pane ─────────────────────────────────────────────────────────────

function renderPreview(article) {
  if (!article) {
    els.previewPane.innerHTML = `
      <div class="preview-empty">
        <span class="preview-icon">CA</span>
        <strong>Select an article</strong>
        <p>Formatted article text, highlights, and notes appear here.</p>
      </div>`;
    return;
  }

  const key        = article.key || articleKey(article);
  const savedText  = state.articleText[key];
  const isLoading  = loadingArticleKeys.has(key);
  const highlights = state.highlights[key] || [];
  const notes      = state.notes[key] || [];
  const inJournal  = !!state.journal[key];
  const isDismissed = state.dismissed.includes(key);

  let readerContent = "";
  if (savedText) {
    if (savedText.html)            readerContent = buildSafeReaderHtml(savedText.html, highlights);
    else if (savedText.paragraphs?.length) readerContent = savedText.paragraphs.map(p => `<p>${highlightText(p, highlights)}</p>`).join("");
  } else {
    readerContent = `<p class="reader-fallback">${escapeHtml(article.summary || "Fetching article text…")}</p>`;
  }

  els.previewPane.innerHTML = `
    <div class="preview-header">
      <div>
        <span class="label">${escapeHtml(sourceName(article))}</span>
        <h2>${escapeHtml(article.title || "Untitled article")}</h2>
      </div>
      ${article.isNew ? `<span class="new-pill">New</span>` : ""}
    </div>
    <div class="preview-meta">
      <span>${article.publishedAt ? escapeHtml(formatDate(article.publishedAt)) : "Date unavailable"}</span>
      <span>${escapeHtml(article.theme || "Needs Review")}</span>
      <span>${article.confidence || 0}% match</span>
    </div>
    <div class="reader-actions">
      ${savedText && article.link ? `<button class="secondary-button" type="button" data-load-article="${escapeHtml(key)}">Refresh text</button>` : ""}
      <button class="secondary-button" type="button" data-add-note="${escapeHtml(key)}">Add note</button>
      <button class="secondary-button ${inJournal ? "btn-journaled" : ""}" type="button" data-toggle-journal="${escapeHtml(key)}">
        ${inJournal ? "★ In Journal" : "☆ Add to Journal"}
      </button>
      <button class="secondary-button ${isDismissed ? "btn-restore" : "btn-dismiss"}" type="button" data-toggle-dismiss="${escapeHtml(key)}">
        ${isDismissed ? "↩ Restore" : "✕ Irrelevant"}
      </button>
      ${article.link ? `<a class="secondary-button reader-link" href="${escapeHtml(article.link)}" target="_blank" rel="noopener noreferrer">Open original</a>` : ""}
    </div>
    <div id="article-reader" class="article-reader" data-article-key="${escapeHtml(key)}">
      <div class="reader-source">${
        savedText
          ? `From ${escapeHtml(savedText.source || sourceName(article))} &middot; ${savedText.wordCount || 0} words &middot; <em>Select text to highlight</em>`
          : isLoading ? "Loading article text…" : "RSS preview &middot; loading full text…"
      }</div>
      ${readerContent}
    </div>
    ${highlights.length ? `
    <div class="preview-section">
      <h3>Saved Highlights (${highlights.length})</h3>
      <ul class="saved-list">
        ${highlights.map(item => `
          <li>
            <span><mark>${escapeHtml(item.text)}</mark></span>
            <button class="text-button" type="button" data-remove-highlight="${escapeHtml(item.id)}">Remove</button>
          </li>`).join("")}
      </ul>
    </div>` : ""}
    <div class="preview-section">
      <h3>Notes</h3>
      <textarea id="note-input" rows="3" placeholder="Write a note for this article…"></textarea>
      <button class="secondary-button note-save" type="button" data-save-note="${escapeHtml(key)}">Save note</button>
      ${notes.length ? `<ul class="saved-list notes-list">${notes.map(note => `
        <li>
          <span>${escapeHtml(note.text)}</span>
          <button class="text-button" type="button" data-remove-note="${escapeHtml(note.id)}">Remove</button>
        </li>`).join("")}</ul>` : ""}
    </div>
    ${article.matchedKeywords?.length ? `
    <div class="preview-section">
      <h3>Matched Keywords</h3>
      <div class="keywords">${article.matchedKeywords.map(w => `<span>${escapeHtml(w)}</span>`).join("")}</div>
    </div>` : ""}
    <div class="preview-section">
      <h3>Original URL</h3>
      <p class="url-line">${escapeHtml(article.link || "Unavailable")}</p>
    </div>`;

  // Wire events
  els.previewPane.querySelector("[data-load-article]")?.addEventListener("click", () => loadArticleText(article));
  els.previewPane.querySelector("[data-add-note]")?.addEventListener("click", focusNoteInput);
  els.previewPane.querySelector("[data-save-note]")?.addEventListener("click", () => saveNote(article));
  els.previewPane.querySelector("[data-toggle-journal]")?.addEventListener("click", () => toggleJournal(article));
  els.previewPane.querySelector("[data-toggle-dismiss]")?.addEventListener("click", () => toggleDismiss(key));
  els.previewPane.querySelectorAll("[data-remove-highlight]").forEach(btn =>
    btn.addEventListener("click", () => removeHighlight(key, btn.dataset.removeHighlight)));
  els.previewPane.querySelectorAll("[data-remove-note]").forEach(btn =>
    btn.addEventListener("click", () => removeNote(key, btn.dataset.removeNote)));

  const reader = els.previewPane.querySelector("#article-reader");
  reader?.addEventListener("mouseup", () => handleReaderMouseUp(article));
  reader?.addEventListener("keyup", () => {
    const sel = window.getSelection()?.toString().replace(/\s+/g, " ").trim() || "";
    if (sel.length >= 3) pendingReaderSelection = sel;
  });

  if (article.link && !savedText && !isLoading) loadArticleText(article);
}

// ─── Dismiss (irrelevant) ─────────────────────────────────────────────────────

function toggleDismiss(key) {
  if (state.dismissed.includes(key)) {
    state.dismissed = state.dismissed.filter(k => k !== key);
    setStatus("Article restored.", "ok");
  } else {
    state.dismissed.push(key);
    if (state.selectedArticleKey === key) state.selectedArticleKey = "";
    setStatus("Article marked irrelevant — won't show again.", "ok");
  }
  persist();
  renderArticles();
}

// ─── Weekly journal ───────────────────────────────────────────────────────────

function toggleJournal(article) {
  const key = article.key || articleKey(article);
  if (state.journal[key]) {
    delete state.journal[key];
    setStatus("Removed from journal.", "ok");
  } else {
    const now = new Date();
    state.journal[key] = {
      key,
      title:       article.title     || "Untitled",
      source:      sourceName(article),
      theme:       article.theme     || "Needs Review",
      link:        article.link      || "",
      publishedAt: article.publishedAt || "",
      addedAt:     now.toISOString(),
      weekKey:     isoWeekKey(now)
    };
    setStatus("Added to weekly journal.", "ok");
  }
  persist();
  renderPreview(article);
  renderArticles();
}

function renderJournalView() {
  const container = els.journalView;
  const entries   = Object.values(state.journal);

  if (!entries.length) {
    container.innerHTML = `
      <div class="empty" style="margin-top:32px">
        <strong>Journal is empty.</strong>
        <span>Open an article and click "☆ Add to Journal" to save important stories here.</span>
      </div>`;
    return;
  }

  // Group by week, newest first
  const byWeek = {};
  for (const entry of entries) {
    if (!byWeek[entry.weekKey]) byWeek[entry.weekKey] = [];
    byWeek[entry.weekKey].push(entry);
  }
  const weeks = Object.keys(byWeek).sort().reverse();

  const totalEntries = entries.length;

  container.innerHTML = `
    <div class="hl-header">
      <p class="eyebrow">Important news</p>
      <h2>Weekly Journal</h2>
      <p class="hl-subtitle">${totalEntries} article${totalEntries !== 1 ? "s" : ""} across ${weeks.length} week${weeks.length !== 1 ? "s" : ""}</p>
    </div>
    ${weeks.map(weekKey => {
      const weekEntries = byWeek[weekKey].sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt));
      return `
        <div class="journal-week">
          <div class="journal-week-header">
            <h3 class="journal-week-label">${formatWeekLabel(weekKey)}</h3>
            <span class="journal-week-count">${weekEntries.length} article${weekEntries.length !== 1 ? "s" : ""}</span>
          </div>
          <div class="journal-entries">
            ${weekEntries.map(entry => {
              const highlights = state.highlights[entry.key] || [];
              const notes      = state.notes[entry.key]      || [];
              return `
                <div class="journal-entry">
                  <div class="journal-entry-header">
                    <div class="journal-entry-title-block">
                      <span class="label">${escapeHtml(entry.source)}</span>
                      <h4 class="journal-entry-title">${escapeHtml(entry.title)}</h4>
                    </div>
                    <div class="journal-entry-actions">
                      <span class="tag">${escapeHtml(entry.theme)}</span>
                      <button class="secondary-button" type="button" data-journal-open="${escapeHtml(entry.key)}">Open</button>
                      <button class="text-button text-button-muted" type="button" data-journal-remove="${escapeHtml(entry.key)}">Remove</button>
                    </div>
                  </div>
                  ${highlights.length ? `
                  <div class="journal-annotations">
                    <span class="journal-annotations-label">Highlights</span>
                    <div class="journal-highlights-list">
                      ${highlights.map(h => `<span class="journal-highlight-chip"><mark>${escapeHtml(h.text)}</mark></span>`).join("")}
                    </div>
                  </div>` : ""}
                  ${notes.length ? `
                  <div class="journal-annotations">
                    <span class="journal-annotations-label">Notes</span>
                    <ul class="journal-notes-list">
                      ${notes.map(n => `<li>${escapeHtml(n.text)}</li>`).join("")}
                    </ul>
                  </div>` : ""}
                  <div class="journal-entry-footer">
                    <span>Added ${formatDate(entry.addedAt)}</span>
                    ${entry.link ? `<a href="${escapeHtml(entry.link)}" target="_blank" rel="noopener noreferrer" class="journal-orig-link">Original ↗</a>` : ""}
                  </div>
                </div>`;
            }).join("")}
          </div>
        </div>`;
    }).join("")}`;

  container.querySelectorAll("[data-journal-open]").forEach(btn =>
    btn.addEventListener("click", () => {
      state.selectedArticleKey = btn.dataset.journalOpen;
      state.activeTab = "articles";
      localStorage.setItem("cae.selectedArticleKey", state.selectedArticleKey);
      render();
    }));

  container.querySelectorAll("[data-journal-remove]").forEach(btn =>
    btn.addEventListener("click", () => {
      delete state.journal[btn.dataset.journalRemove];
      persist();
      renderJournalView();
    }));
}

// ─── ISO week helpers ─────────────────────────────────────────────────────────

function isoWeekKey(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function formatWeekLabel(weekKey) {
  const [year, weekNum] = weekKey.split("-W").map(Number);
  // Monday of ISO week: find Jan 4 (always in week 1) then offset
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - (jan4.getUTCDay() || 7) + 1 + (weekNum - 1) * 7);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  const fmt = d => d.toLocaleDateString("en-IN", { month: "short", day: "numeric", timeZone: "UTC" });
  return `Week ${weekNum} &nbsp;·&nbsp; ${fmt(monday)} – ${fmt(sunday)}, ${year}`;
}

// ─── Floating selection toolbar ───────────────────────────────────────────────

function handleReaderMouseUp(article) {
  const selection = window.getSelection();
  const text = selection?.toString().replace(/\s+/g, " ").trim() || "";
  if (!text || text.length < 3) { hideSelectionToolbar(); return; }

  const reader = document.querySelector("#article-reader");
  if (!reader || selection.rangeCount === 0) return;

  const range = selection.getRangeAt(0);
  if (!reader.contains(range.commonAncestorContainer)) return;

  pendingReaderSelection = text;
  showSelectionToolbar(range, article);
}

function showSelectionToolbar(range, article) {
  let toolbar = document.querySelector("#selection-toolbar");
  if (!toolbar) {
    toolbar = document.createElement("div");
    toolbar.id = "selection-toolbar";
    toolbar.className = "selection-toolbar";
    document.body.appendChild(toolbar);
  }

  toolbar.innerHTML = `
    <button type="button" class="stb-btn stb-highlight">Highlight</button>
    <button type="button" class="stb-btn stb-note">Add to Notes</button>`;

  const rect = range.getBoundingClientRect();
  const W = 218;
  let left = rect.left + window.scrollX + rect.width / 2 - W / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - W - 8));
  toolbar.style.cssText = `display:flex; top:${rect.top + window.scrollY - 50}px; left:${left}px;`;

  toolbar.querySelector(".stb-highlight").onmousedown = e => {
    e.preventDefault(); saveHighlight(article); toolbar.style.display = "none";
  };
  toolbar.querySelector(".stb-note").onmousedown = e => {
    e.preventDefault(); toolbar.style.display = "none";
    const input = document.querySelector("#note-input");
    if (input) { input.value = pendingReaderSelection; input.focus(); input.scrollIntoView({ behavior: "smooth", block: "nearest" }); }
  };
}

function hideSelectionToolbar() {
  const t = document.querySelector("#selection-toolbar");
  if (t) t.style.display = "none";
}

// ─── Highlights view ──────────────────────────────────────────────────────────

function renderHighlightsView() {
  const container = els.highlightsView;
  const annotated = state.articles.filter(a => {
    const key = a.key || articleKey(a);
    return (state.highlights[key]?.length || 0) + (state.notes[key]?.length || 0) > 0;
  });

  if (!annotated.length) {
    container.innerHTML = `
      <div class="empty" style="margin-top:32px">
        <strong>No highlights or notes yet.</strong>
        <span>Select text in the reader and tap "Highlight" to save it here.</span>
      </div>`;
    return;
  }

  const totalHL = annotated.reduce((n, a) => n + (state.highlights[a.key||articleKey(a)]?.length||0), 0);
  const totalN  = annotated.reduce((n, a) => n + (state.notes[a.key||articleKey(a)]?.length||0), 0);

  container.innerHTML = `
    <div class="hl-header">
      <p class="eyebrow">Saved annotations</p>
      <h2>Highlights &amp; Notes</h2>
      <p class="hl-subtitle">${totalHL} highlight${totalHL!==1?"s":""} &middot; ${totalN} note${totalN!==1?"s":""} across ${annotated.length} article${annotated.length!==1?"s":""}</p>
    </div>
    <div class="hl-list">
      ${annotated.map(article => {
        const key = article.key || articleKey(article);
        const highlights = state.highlights[key] || [];
        const notes      = state.notes[key]      || [];
        return `
          <div class="hl-card">
            <div class="hl-card-header">
              <div class="hl-card-title-block">
                <span class="label">${escapeHtml(sourceName(article))}</span>
                <h3 class="hl-card-title">${escapeHtml(article.title || "Untitled")}</h3>
              </div>
              <div class="hl-card-actions">
                <span class="tag">${escapeHtml(article.theme)}</span>
                <button class="secondary-button" type="button" data-jump-to="${escapeHtml(key)}">Open article</button>
              </div>
            </div>
            ${highlights.length ? `
            <div class="hl-section">
              <span class="hl-section-label">Highlights</span>
              <ul class="hl-items">
                ${highlights.map(h => `
                  <li class="hl-item highlight-item">
                    <mark>${escapeHtml(h.text)}</mark>
                    <div class="hl-item-footer">
                      <span class="hl-timestamp">${formatDate(h.createdAt)}</span>
                      <button class="text-button" type="button" data-remove-highlight-hl="${escapeHtml(key)}" data-id="${escapeHtml(h.id)}">Remove</button>
                    </div>
                  </li>`).join("")}
              </ul>
            </div>` : ""}
            ${notes.length ? `
            <div class="hl-section">
              <span class="hl-section-label">Notes</span>
              <ul class="hl-items">
                ${notes.map(n => `
                  <li class="hl-item note-item">
                    <p>${escapeHtml(n.text)}</p>
                    <div class="hl-item-footer">
                      <span class="hl-timestamp">${formatDate(n.createdAt)}</span>
                      <button class="text-button" type="button" data-remove-note-hl="${escapeHtml(key)}" data-id="${escapeHtml(n.id)}">Remove</button>
                    </div>
                  </li>`).join("")}
              </ul>
            </div>` : ""}
          </div>`;
      }).join("")}
    </div>`;

  container.querySelectorAll("[data-jump-to]").forEach(btn =>
    btn.addEventListener("click", () => {
      state.selectedArticleKey = btn.dataset.jumpTo;
      state.activeTab = "articles";
      localStorage.setItem("cae.selectedArticleKey", state.selectedArticleKey);
      render();
    }));
  container.querySelectorAll("[data-remove-highlight-hl]").forEach(btn =>
    btn.addEventListener("click", () => { removeHighlight(btn.dataset.removeHighlightHl, btn.dataset.id); renderHighlightsView(); }));
  container.querySelectorAll("[data-remove-note-hl]").forEach(btn =>
    btn.addEventListener("click", () => { removeNote(btn.dataset.removeNoteHl, btn.dataset.id); renderHighlightsView(); }));
}

// ─── Article loading ──────────────────────────────────────────────────────────

function selectArticle(key) {
  state.selectedArticleKey = key;
  pendingReaderSelection = "";
  localStorage.setItem("cae.selectedArticleKey", key);
  renderArticles();
  const article = state.articles.find(a => (a.key || articleKey(a)) === key);
  if (article?.link && !state.articleText[key]) loadArticleText(article);
}

async function loadArticleText(article) {
  const key = article.key || articleKey(article);
  if (loadingArticleKeys.has(key)) return;
  if (!article.link) { setStatus("This article does not have an original link to fetch.", "error"); return; }

  loadingArticleKeys.add(key);
  setStatus("Loading article text…", "loading");
  const button = els.previewPane.querySelector("[data-load-article]");
  if (button) button.disabled = true;

  try {
    const resp = await fetch(`/api/article?url=${encodeURIComponent(article.link)}`);
    const payload = await resp.json();
    if (!resp.ok) throw new Error(payload.error || "Could not load article");
    if (!payload.paragraphs?.length && !payload.html) throw new Error("Could not extract readable text from this page.");
    state.articleText[key] = payload;
    persist();
    setStatus(`Loaded article: ${payload.wordCount || 0} words.`, "ok");
  } catch (err) {
    setStatus(err.message || "Could not load article text.", "error");
  } finally {
    loadingArticleKeys.delete(key);
    renderPreview(article);
  }
}

// ─── Annotations ─────────────────────────────────────────────────────────────

function saveHighlight(article) {
  const key  = article.key || articleKey(article);
  const text = pendingReaderSelection;
  if (!text || text.length < 3) { setStatus("Select text inside the reader pane first.", "error"); return; }
  state.highlights[key] = state.highlights[key] || [];
  if (!state.highlights[key].some(h => h.text === text)) {
    state.highlights[key].push({ id: makeId(), text, createdAt: new Date().toISOString() });
    persist(); setStatus("Highlight saved.", "ok");
  } else { setStatus("Already highlighted.", "ok"); }
  pendingReaderSelection = "";
  renderPreview(article);
}

function focusNoteInput() { document.querySelector("#note-input")?.focus(); }

function saveNote(article) {
  const key   = article.key || articleKey(article);
  const input = document.querySelector("#note-input");
  const text  = input?.value.trim() || pendingReaderSelection;
  if (!text) { setStatus("Write a note or select text to add to notes.", "error"); return; }
  state.notes[key] = state.notes[key] || [];
  state.notes[key].push({ id: makeId(), text, createdAt: new Date().toISOString() });
  if (input) input.value = "";
  pendingReaderSelection = "";
  persist(); setStatus("Note saved.", "ok");
  renderPreview(article);
}

function removeHighlight(key, id) {
  state.highlights[key] = (state.highlights[key] || []).filter(h => h.id !== id);
  persist(); renderArticles();
}

function removeNote(key, id) {
  state.notes[key] = (state.notes[key] || []).filter(n => n.id !== id);
  persist(); renderArticles();
}

// ─── Rich HTML rendering ──────────────────────────────────────────────────────

function buildSafeReaderHtml(rawHtml, highlights) {
  const parser = new DOMParser();
  const doc    = parser.parseFromString(rawHtml, "text/html");
  for (const el of doc.querySelectorAll("script,style,iframe,object,embed,form,input,button,select")) el.remove();
  for (const el of doc.querySelectorAll("*")) {
    for (const attr of [...el.attributes]) {
      if (attr.name.startsWith("on") || (attr.name === "href" && /^\s*javascript:/i.test(attr.value)))
        el.removeAttribute(attr.name);
    }
  }
  const container = document.createElement("div");
  container.innerHTML = doc.body.innerHTML;
  for (const h of highlights) applyHighlightToDoc(container, h.text);
  return container.innerHTML;
}

function applyHighlightToDoc(container, searchText) {
  if (!searchText || searchText.length < 3) return;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
  const nodes  = [];
  let node;
  while ((node = walker.nextNode())) nodes.push(node);
  for (const textNode of nodes) {
    const idx = textNode.nodeValue.indexOf(searchText);
    if (idx === -1) continue;
    try {
      const range = document.createRange();
      range.setStart(textNode, idx);
      range.setEnd(textNode, idx + searchText.length);
      const mark = document.createElement("mark");
      range.surroundContents(mark);
    } catch {}
    break;
  }
}

function highlightText(text, highlights) {
  let out = escapeHtml(text);
  for (const h of highlights) {
    const esc = escapeHtml(h.text);
    if (esc) out = out.replaceAll(esc, `<mark>${esc}</mark>`);
  }
  return out;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function makeId()   { return `${Date.now()}-${Math.random().toString(16).slice(2)}`; }
function sources()  { return [...new Set(state.articles.map(sourceName).filter(Boolean))].sort((a,b) => a.localeCompare(b)); }
function sourceName(a) { return a.feedTitle || hostName(a.feedUrl) || "Unknown Source"; }
function articleKey(a) { return String(a.id || a.link || a.title || "").trim().toLowerCase(); }
function sortByDate(a,b) { return (Date.parse(b.publishedAt||"")||0) - (Date.parse(a.publishedAt||"")||0); }

function setStatus(msg, type) {
  els.scanStatus.textContent    = msg;
  els.scanStatus.dataset.type   = type;
}

function persist() {
  localStorage.setItem("cae.feeds",              JSON.stringify(state.feeds));
  localStorage.setItem("cae.themes",             JSON.stringify(state.themes));
  localStorage.setItem("cae.articles",           JSON.stringify(state.articles));
  localStorage.setItem("cae.seen",               JSON.stringify(state.seen));
  localStorage.setItem("cae.articleText",        JSON.stringify(state.articleText));
  localStorage.setItem("cae.highlights",         JSON.stringify(state.highlights));
  localStorage.setItem("cae.notes",              JSON.stringify(state.notes));
  localStorage.setItem("cae.dismissed",          JSON.stringify(state.dismissed));
  localStorage.setItem("cae.journal",            JSON.stringify(state.journal));
  localStorage.setItem("cae.selectedArticleKey", state.selectedArticleKey);
  schedulDbSave(); // debounced cloud save
}

// ─── Cloud DB sync ────────────────────────────────────────────────────────────

async function loadFromDb() {
  try {
    const resp = await fetch("/api/db");
    if (!resp.ok) return; // DB not available (e.g. local dev without db.json yet)
    const remote = await resp.json();
    if (!remote || typeof remote !== "object" || !Object.keys(remote).length) return;

    // Remote wins for all persisted keys — merge into current state
    const keys = ["feeds","themes","seen","articles","highlights","notes","dismissed","journal","lastScan"];
    let changed = false;
    for (const k of keys) {
      if (remote[k] !== undefined) { state[k] = remote[k]; changed = true; }
    }
    if (remote.lastScan) localStorage.setItem("cae.lastScan", remote.lastScan);

    if (changed) {
      // Refresh localStorage cache then re-render with cloud state
      localStorage.setItem("cae.feeds",      JSON.stringify(state.feeds));
      localStorage.setItem("cae.themes",     JSON.stringify(state.themes));
      localStorage.setItem("cae.articles",   JSON.stringify(state.articles));
      localStorage.setItem("cae.seen",       JSON.stringify(state.seen));
      localStorage.setItem("cae.highlights", JSON.stringify(state.highlights));
      localStorage.setItem("cae.notes",      JSON.stringify(state.notes));
      localStorage.setItem("cae.dismissed",  JSON.stringify(state.dismissed));
      localStorage.setItem("cae.journal",    JSON.stringify(state.journal));
      render();
      setStatus("Synced from cloud.", "ok");
    }
  } catch {
    // Silently fail — localStorage state is already loaded and shown
  }
}

function schedulDbSave() {
  clearTimeout(dbSaveTimer);
  dbSaveTimer = setTimeout(saveToDb, 1500);
}

async function saveToDb() {
  // Exclude articleText (full HTML/text bodies) — too large for Redis, re-fetched on demand
  const payload = {
    feeds:      state.feeds,
    themes:     state.themes,
    seen:       state.seen.slice(-1000),
    articles:   state.articles.slice(0, 200).map(a => ({
      ...a,
      summary: (a.summary || "").slice(0, 200)  // truncate long summaries
    })),
    highlights: state.highlights,
    notes:      state.notes,
    dismissed:  state.dismissed,
    journal:    state.journal,
    lastScan:   state.lastScan
  };

  try {
    await fetch("/api/db", {
      method:  "POST",
      headers: { "content-type": "application/json" },
      body:    JSON.stringify(payload)
    });
  } catch {
    // Fire-and-forget — localStorage is the source of truth for this session
  }
}

function load(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; }
  catch { return fallback; }
}

function formatDate(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return new Intl.DateTimeFormat("en-IN", { day:"2-digit", month:"short", year:"numeric", hour:"2-digit", minute:"2-digit" }).format(d);
}

function hostName(value) {
  try { return new URL(value).hostname.replace(/^www\./, ""); } catch { return "RSS Feed"; }
}

function escapeHtml(value) {
  return String(value ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
