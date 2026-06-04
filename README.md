# Shivam Shaurya's Current Affairs Engine

A local web/mobile-friendly RSS reader and UPSC theme classifier.

## Run

```powershell
cd current-affairs-engine
npm start
```

Then open:

```text
http://localhost:4173
```

## What Works Now

- Add and remove RSS feed URLs.
- Refresh all configured feeds from the server, which avoids browser CORS limits.
- Deduplicate articles across feeds.
- Add, remove, and update UPSC themes with comma-separated keywords.
- Tag each fetched article to the best matching theme.
- Filter by theme, new articles, or search text.
- Persist feeds, themes, seen articles, and fetched articles in browser local storage.

## Next Phase

The Groq API extraction layer can be added after the final theme structure and output format are settled. The intended next step is to send selected/raw article text to Groq and store returned facts, pointers, and ideas under the article's theme.
