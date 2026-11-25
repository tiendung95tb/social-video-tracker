---
name: social-video-tracker
description: Use when the user wants to track, scan, or report on monthly TikTok and Facebook channel video counts, views, likes, and comments via the Social Video Tracker MCP App, or sync/export channel reports with Google Sheets.
---

# Social Video Tracker

Tracks TikTok and Facebook channels stored in local SQLite (`${PLUGIN_DATA}/tracker.sqlite`) and scans monthly performance since the 1st of the month (`YYYY-MM-01`) via Apify with strict Free-tier (\$5/mo) budget controls.

## Tools

- `open_social_tracker`: Opens the interactive dashboard (Side Pane, Sidebar, or inline). Use whenever the user wants to view KPIs, manage channels, configure Apify/Google Sheets, run scans, or export CSV.
- `get_monthly_report`: Reads cached monthly stats from local SQLite (\$0 Apify cost). Prefer this for answering analytics questions.
- `scan_channels`: Runs a batched Apify scan since `YYYY-MM-01` with `maxTotalChargeUsd` budget enforcement. Use `dryRun: true` to estimate cost before spending.
- `sync_channels_from_sheet`: Imports/updates channels from any Google Sheet 2D row array (auto-detects columns from headers and scans all cells for TikTok/Facebook URLs).
- `prepare_sheet_export`: Generates a `gsheets mutate batch` JSON file for exporting a month (`YYYY-MM`) as its own tab and saves `exportSheetUrl` in settings.

## Syncing Channels From a Google Sheet

1. Read the user's Google Sheet URL (either passed in chat or configured in Settings).
2. Extract `<SPREADSHEET_ID>` and optional `gid`.
3. If no tab name is given, resolve the tab title via `gsheets readonly list-sheets <SPREADSHEET_ID> --json`.
4. Fetch rows with embedded hyperlinks: `gsheets readonly read-links <SPREADSHEET_ID> "'<TAB_NAME>'!A1:Z200" --json`.
5. Pass the 2D array into `sync_channels_from_sheet` along with `sheetUrl` and `sheetTab`.

## Exporting Monthly Reports to Google Sheets (1 Tab per Month)

1. Call `prepare_sheet_export({ month })` to generate `batchFilePath` and read `exportSpreadsheetId`.
2. If no `exportSpreadsheetId` is configured yet:
   - Create a spreadsheet: `gsheets mutate create --title "Social Video Tracker - Monthly Reports" --json`.
   - Rename sheet 0 to `<YYYY-MM>`: `gsheets mutate rename-sheet <ID> --sheet-id 0 --title "<YYYY-MM>"`.
   - Save the URL: `prepare_sheet_export({ month, exportSheetUrl: "https://docs.google.com/spreadsheets/d/<ID>/edit" })`.
3. If `exportSpreadsheetId` exists:
   - Check tabs via `gsheets readonly list-sheets <ID> --json`.
   - If tab `<YYYY-MM>` does not exist, create it via `gsheets mutate add-sheet <ID> --title "<YYYY-MM>"`.
4. Write rows via `gsheets mutate batch <ID> -f <batchFilePath>`, then format header rows, freeze the header, and autosize columns.
5. Return the clickable Google Sheet URL to the user without making it publicly shared unless explicitly requested.
