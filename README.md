# Social Video Tracker (Antigravity Plugin & MCP App)

Track monthly **TikTok** and **Facebook Reels** channel video counts, views, likes, comments, and shares directly inside **Antigravity** — built to stay within **Apify's Free tier (\$5/month)** with local SQLite history, async scanning, CSV export, and two-way **Google Sheets** sync & monthly tab reporting.

## Features

- **Interactive MCP App Dashboard:** Opens in the Antigravity Side Pane (`+` → **Social Tracker**) or full-page from the left Sidebar, synced with host light/dark themes.
- **Month-to-Date Scanning (`YYYY-MM-01`):** Batches all enabled channels into parallel Apify runs with `oldestPostDateUnified` date cutoffs and non-blocking 4-second live polling (never hits 60s RPC timeouts).
- **Apify Free-Tier (\$5/mo) Guardrails:**
  - Hard per-run budget cap (`maxTotalChargeUsd`, default `\$2.20`)
  - Dry-run cost estimator (`\$0`) and 3-channel test mode (`~\$0.05`)
  - Live Apify account credit meter (`/v2/users/me/limits`)
  - Configurable Actor IDs (defaults: `clockworks/tiktok-profile-scraper` & `alfalfa/facebook-reels-scraper`)
- **Flexible Input & Output via Google Sheets:**
  - Sync channel lists from **any** Google Sheet URL (auto-detects header columns and scans all cells for TikTok/Facebook links)
  - Export monthly reports to Google Sheets with **1 tab per month (`YYYY-MM`)**, including KPI headers, channel details, and creator/group rollups
- **Local-First & Private:** All SQLite data and your Apify API token are stored locally inside `${PLUGIN_DATA}`; your API token never passes through LLM chat history.

## Requirements

- [Bun](https://bun.sh) runtime (`curl -fsSL https://bun.sh/install | bash`)
- Free [Apify](https://console.apify.com) account (\$5/month free credit, no credit card required)
- *(Optional)* Official **Google Sheets** plugin installed in Antigravity for 1-click sheet sync & monthly export

## Installation

### From GitHub (Antigravity CLI)

```bash
agy plugin install https://github.com/tiendung95tb/social-video-tracker
```

### Manual / Local Installation

```bash
git clone https://github.com/tiendung95tb/social-video-tracker ~/.gemini/config/plugins/social-video-tracker
chmod +x ~/.gemini/config/plugins/social-video-tracker/scripts/social-video-tracker
```

*(Pre-built server and UI bundles are included — no `bun install` or build step required.)*

## Quick Start

1. Open **Social Tracker** from the Antigravity Side Pane (`+`) or left Sidebar.
2. Go to **Scan & Settings** → paste your Apify Personal API token → click **Verify Token & Balance**.
3. Add channels via **+ Add Channels** (single or bulk URL paste), or paste your **Input Google Sheet URL** and click **Save & Sync Now**.
4. Click **Estimate (\$0)** or **Test 3 Channels**, then run **Scan since `YYYY-MM-01`**.
5. Click **Export Google Sheet** to generate a formatted `YYYY-MM` monthly tab (or **Export CSV** for Excel).

## Development

```bash
bun install
bun run build       # builds ui/dist/index.html + server/dist/index.js
bun run typecheck   # TypeScript strict check
bun test            # runs server unit tests
```

## License

MIT
