# Copilot instructions for FBMonitor

Overview
- **Purpose**: This repo is a Puppeteer-based Facebook Group monitor that scans groups for keyword-matching posts and persists results to `results.json` (and optionally Google Sheets).
- **Key files**: `index.js` (main program), `export_to_sheet.js` (one-off export), `config.json` (runtime settings), `fb_cookies.json` (cookie store), `results.json`, `cacheIndexpost.json`.

How the app works (big picture)
- `index.js` loads `config.json` and cookies from `fb_cookies.json`, starts Puppeteer (uses `puppeteer-extra-plugin-stealth`) and opens multiple tabs to scan `https://www.facebook.com/groups/<groupId>` pages.
- Posts are extracted from DOM `article[role="article"]` elements, matched against a lower-cased `keywords` set, deduplicated using `results.json`, and recent post indices are tracked in `cacheIndexpost.json`.
- Optional notification/export: `notification.googleSheet` config initializes `GoogleSheetService` (see `index.js`) or use `export_to_sheet.js` to push `results.json` into a spreadsheet.

Important conventions and config examples
- `config.json` structure (minimal example used by the code):
```json
{
  "keywords": ["mua", "ban"],
  "groupIds": ["12345"],
  "performance": { "maxConcurrentTabs": 10, "groupCooldownMinutes": 30 },
  "notification": {
    "googleSheet": { "enabled": true, "sheetId": "...", "serviceAccountKeyFile": "sa-key.json" }
  }
}
```
- `fb_cookies.json` must follow Browser Cookie Editor format (object with `cookies` array). If missing, run the program and it will create a template file. `index.js` reads the file, maps fields then calls `page.setCookie(...)`.
- To refresh and persist cookies captured during a session the code calls `refreshCookies()` which writes `fb_cookies.json` in Cookie Editor format.

Patterns and pitfalls for code edits and agents
- DOM scraping is fragile: selectors look for `article[role="article"]` and several time/author selectors. Change selectors only after validating in a real browser snapshot.
- Concurrency is controlled by `config.performance.maxConcurrentTabs` (and `this.maxConcurrentTabs` fallback). To reduce bot load lower this value.
- To debug visually, set `headless: false` in the `puppeteer.launch()` call inside `index.js` (search for `puppeteer.launch({ headless:`). Also increasing timeouts in `CONSTANTS.TIMEOUTS` helps during manual debugging.
- User agent is defined in `CONSTANTS.USER_AGENT` — keep it updated when testing different environments.

Google Sheets integration
- `index.js` uses `GoogleSheetService` (service account JSON + `sheetId`). `export_to_sheet.js` is a standalone helper that reads `results.json` and writes header+rows, then attempts formatting (may fail if the service account lacks spreadsheet permissions).
- Example config fields: `notification.googleSheet.sheetId`, `notification.googleSheet.serviceAccountKeyFile`, `notification.googleSheet.enabled`.

Runtime and developer workflows
- Run: `node index.js` (requires Node and packages from `package.json`).
- One-off export: `node export_to_sheet.js` will push the current `results.json` to the configured sheet.
- No tests present. Use small iterative runs and the `fb_cookies.json` template to validate flows locally.

Where to look for behavior when editing
- Search `index.js` for: `loadConfig()`, `loadCookiesFromFile()`, `scanGroupInTab()`, `mergeResult()`, and `saveLatestPostIndex()` to understand the main flow.
- Data files are read/written in repository root: `config.json`, `fb_cookies.json`, `results.json`, `cacheIndexpost.json`.

Edit guidance for AI agents
- Preserve Vietnamese log messages and existing file paths when changing code unless translating the whole project; logs are used by humans who run the script.
- When you change DOM selectors, include a short comment referencing the original selector and why it needed change, and add a simple local test: set `headless:false`, run one group id, and save a page HTML snapshot for inspection.
- When adding features that persist data, update both `results.json` handling and `export_to_sheet.js` so exports remain consistent.

Questions for the maintainer (ask before larger changes)
- Which notification channels are actively used (Telegram/Zalo/Google Sheet)?
- Do you want a CI script or a small CLI wrapper to run with specific config files or modes (debug vs scheduled)?

If anything here is unclear or you want more examples (config fields, sample `fb_cookies.json`, or a quick debug/run guide), tell me which parts to expand.
