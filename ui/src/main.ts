import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';
import { z } from 'zod';
import type { DashboardPayload, Platform } from '../../server/src/types.js';
import './styles.css';

interface VideoRow {
  id: string;
  channelId: number;
  platform: Platform;
  url: string;
  caption: string;
  publishedAt: string | null;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  channelName: string;
  doctorGroup: string;
  channelHandle: string;
}

type TabKey = 'channels' | 'groups' | 'videos' | 'settings';

const state: {
  dashboard: DashboardPayload | null;
  activeTab: TabKey;
  month: string;
  platformFilter: 'all' | 'tiktok' | 'facebook';
  search: string;
  busyLabel: string | null;
  banner: { kind: 'info' | 'success' | 'warning' | 'danger'; title: string; detail?: string } | null;
  topVideos: VideoRow[];
  videosSortBy: 'views' | 'published_at';
  channelModal: { channelName: string; handle: string; videos: VideoRow[] } | null;
  showAddModal: boolean;
  scanSinceDate: string;
  scanPlatform: 'all' | 'tiktok' | 'facebook';
  scanMaxTiktok: number;
  scanMaxFb: number;
  scanBudgetUsd: number;
  capabilities: {
    message: boolean;
    updateModelContext: boolean;
    openLinks: boolean;
  };
} = {
  dashboard: null,
  activeTab: 'channels',
  month: new Date().toISOString().slice(0, 7),
  platformFilter: 'all',
  search: '',
  busyLabel: null,
  banner: null,
  topVideos: [],
  videosSortBy: 'views',
  channelModal: null,
  showAddModal: false,
  scanSinceDate: `${new Date().toISOString().slice(0, 7)}-01`,
  scanPlatform: 'all',
  scanMaxTiktok: 18,
  scanMaxFb: 20,
  scanBudgetUsd: 2.2,
  capabilities: { message: false, updateModelContext: false, openLinks: false },
};

const app = new App({ name: 'Social Video Tracker', version: '1.0.0' }, {});

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return new Intl.NumberFormat('en-US').format(n);
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return 'Not scanned';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: '2-digit' });
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-US', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function syncDashboardState(dash: DashboardPayload) {
  state.dashboard = dash;
  state.month = dash.month;
  if (!state.scanSinceDate.startsWith(dash.month)) {
    state.scanSinceDate = dash.sinceDate;
  }
  state.scanMaxTiktok = dash.settings.defaultMaxVideosTiktok;
  state.scanMaxFb = dash.settings.defaultMaxVideosFacebook;
  state.scanBudgetUsd = dash.settings.perRunBudgetUsd;
}

async function callTool<T = Record<string, unknown>>(
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ isError?: boolean; text: string; structured: T | null }> {
  const res = await app.callServerTool({ name, arguments: args });
  const textParts = (res.content ?? [])
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text);
  return {
    isError: Boolean(res.isError),
    text: textParts.join('\n'),
    structured: (res.structuredContent as T | undefined) ?? null,
  };
}

async function refreshDashboard(opts?: { month?: string; platform?: 'all' | 'tiktok' | 'facebook'; search?: string }) {
  const month = opts?.month ?? state.month;
  const platform = opts?.platform ?? state.platformFilter;
  const search = opts?.search ?? state.search;
  state.month = month;
  state.platformFilter = platform;
  state.search = search;
  state.scanSinceDate = `${month}-01`;

  const res = await callTool<DashboardPayload>('app_get_dashboard', { month, platform, search });
  if (res.structured) syncDashboardState(res.structured);
  if (state.activeTab === 'videos') await loadTopVideos();
  render();
}

async function loadTopVideos() {
  const res = await callTool<{ videos: VideoRow[] }>('app_get_videos', {
    month: state.month,
    platform: state.platformFilter,
    sortBy: state.videosSortBy,
    limit: 120,
  });
  state.topVideos = res.structured?.videos ?? [];
}

async function openChannelVideos(channelId: number, channelName: string, handle: string) {
  state.busyLabel = `Loading videos for ${channelName}...`;
  render();
  try {
    const res = await callTool<{ videos: VideoRow[] }>('app_get_videos', {
      month: state.month,
      channelId,
      sortBy: 'views',
      limit: 100,
    });
    state.channelModal = { channelName, handle, videos: res.structured?.videos ?? [] };
  } finally {
    state.busyLabel = null;
    render();
  }
}

let pollTimerId: number | null = null;
let accumulatedNotes: string[] = [];
let autoExportAfterCurrentScan = false;

function stopPolling() {
  if (pollTimerId !== null) {
    window.clearTimeout(pollTimerId);
    pollTimerId = null;
  }
}

async function pollRunningScansOnce() {
  stopPolling();
  try {
    const res = await callTool<{
      stillRunningCount: number;
      completedNotes: string[];
      progressLines: string[];
      dashboard?: DashboardPayload;
    }>('app_poll_scan', { month: state.month });

    if (res.structured?.dashboard) syncDashboardState(res.structured.dashboard);
    const completed = res.structured?.completedNotes ?? [];
    if (completed.length > 0) {
      accumulatedNotes.push(...completed);
      if (state.activeTab === 'videos') await loadTopVideos();
    }

    const stillRunning = res.structured?.stillRunningCount ?? 0;
    const progress = res.structured?.progressLines ?? [];

    if (stillRunning > 0) {
      state.busyLabel =
        progress.length > 0
          ? `Scanning in parallel on Apify — ${progress.join(' | ')}`
          : `Monitoring ${stillRunning} active Apify job(s)...`;
      render();
      pollTimerId = window.setTimeout(() => void pollRunningScansOnce(), 4000);
    } else {
      state.busyLabel = null;
      const shouldAutoExport = autoExportAfterCurrentScan;
      autoExportAfterCurrentScan = false;
      if (accumulatedNotes.length > 0) {
        state.banner = { kind: 'success', title: 'Apify scan completed', detail: accumulatedNotes.join('\n') };
        accumulatedNotes = [];
        if (shouldAutoExport && state.capabilities.message && state.dashboard?.settings.exportSheetUrl) {
          await requestExportToGoogleSheet();
          return;
        }
      }
      render();
    }
  } catch (err) {
    state.busyLabel = null;
    autoExportAfterCurrentScan = false;
    state.banner = {
      kind: 'warning',
      title: 'Status polling paused (Apify job continues in background)',
      detail: err instanceof Error ? err.message : String(err),
    };
    render();
  }
}

async function runScan(opts: { dryRun?: boolean; testFirst3?: boolean; retryFailedOnly?: boolean }) {
  const dash = state.dashboard;
  if (!dash) return;

  let channelIds: number[] | undefined;
  if (opts.retryFailedOnly) {
    channelIds = dash.channels.filter((c) => c.channel.enabled && Boolean(c.channel.lastError)).map((c) => c.channel.id);
    if (channelIds.length === 0) {
      state.banner = { kind: 'info', title: 'No failed enabled channels to retry.' };
      render();
      return;
    }
  } else if (opts.testFirst3) {
    const enabled = dash.channels.filter((c) => c.channel.enabled);
    const sampleTiktok = enabled.filter((c) => c.channel.platform === 'tiktok').slice(0, 2);
    const sampleFb = enabled.filter((c) => c.channel.platform === 'facebook').slice(0, 1);
    channelIds = [...sampleTiktok, ...sampleFb].map((c) => c.channel.id);
    if (channelIds.length === 0) channelIds = enabled.slice(0, 3).map((c) => c.channel.id);
  }

  state.banner = null;

  if (opts.dryRun) {
    state.busyLabel = 'Calculating cost estimate...';
    render();
    try {
      const res = await callTool<{ ok: boolean; message?: string; dashboard?: DashboardPayload }>('scan_channels', {
        sinceDate: state.scanSinceDate,
        platform: state.scanPlatform,
        maxVideosTiktok: state.scanMaxTiktok,
        maxVideosFacebook: state.scanMaxFb,
        maxBudgetUsd: state.scanBudgetUsd,
        dryRun: true,
      });
      if (res.structured?.dashboard) syncDashboardState(res.structured.dashboard);
      state.banner = {
        kind: 'info',
        title: 'Cost Estimate (Dry Run — $0)',
        detail: res.structured?.message || res.text,
      };
    } finally {
      state.busyLabel = null;
      render();
    }
    return;
  }

  accumulatedNotes = [];
  autoExportAfterCurrentScan = !opts.testFirst3 && !opts.retryFailedOnly && state.capabilities.message;
  state.busyLabel = opts.testFirst3
    ? 'Starting test scan on 3 channels...'
    : `Starting parallel Apify scan since ${state.scanSinceDate}...`;
  render();

  try {
    const res = await callTool<{ ok: boolean; message?: string; dashboard?: DashboardPayload }>('app_start_scan', {
      sinceDate: state.scanSinceDate,
      platform: opts.testFirst3 ? 'all' : state.scanPlatform,
      channelIds,
      maxVideosTiktok: opts.testFirst3 ? 5 : state.scanMaxTiktok,
      maxVideosFacebook: opts.testFirst3 ? 5 : state.scanMaxFb,
      maxBudgetUsd: opts.testFirst3 ? 0.25 : state.scanBudgetUsd,
    });

    if (res.structured?.dashboard) syncDashboardState(res.structured.dashboard);
    if (res.isError || res.structured?.ok === false) {
      state.busyLabel = null;
      state.banner = {
        kind: 'danger',
        title: 'Could not start Apify scan',
        detail: res.structured?.message || res.text,
      };
      render();
      return;
    }

    state.busyLabel = res.structured?.message || 'Monitoring Apify scan progress...';
    render();
    pollTimerId = window.setTimeout(() => void pollRunningScansOnce(), 3000);
  } catch (err) {
    state.busyLabel = null;
    state.banner = {
      kind: 'danger',
      title: 'Failed to launch Apify scan',
      detail: err instanceof Error ? err.message : String(err),
    };
    render();
  }
}

async function handleExportCsv(mode: 'channels' | 'doctors') {
  state.busyLabel = 'Exporting CSV...';
  render();
  try {
    const res = await callTool<{ fileName: string; filePath: string; fileUri: string; csv: string }>(
      'app_export_csv',
      { month: state.month, mode },
    );
    if (res.structured) {
      const blob = new Blob([res.structured.csv], { type: 'text/csv;charset=utf-8;' });
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = res.structured.fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 2000);

      try {
        await app.request(
          {
            method: 'com.google.antigravity/toggle-aux-pane',
            params: { tabType: 'fileView', uri: res.structured.fileUri },
          },
          z.object({ isError: z.boolean().optional() }).passthrough(),
        );
      } catch {
        // Ignore on surfaces without side pane
      }

      state.banner = {
        kind: 'success',
        title: `Exported ${res.structured.fileName}`,
        detail: `Saved to: ${res.structured.filePath}`,
      };
    }
  } finally {
    state.busyLabel = null;
    render();
  }
}

async function openExternalUrl(url: string) {
  if (!url) return;
  if (state.capabilities.openLinks) await app.openLink({ url });
  else window.open(url, '_blank', 'noopener,noreferrer');
}

function buildAiSummaryText(): string {
  const dash = state.dashboard;
  if (!dash) return '';
  const s = dash.summary;
  const topGroups = dash.doctors
    .slice(0, 10)
    .map(
      (d, i) =>
        `${i + 1}. ${d.doctorGroup}: ${d.totalVideos} videos, ${fmtNum(d.totalViews)} views, ${fmtNum(d.totalLikes)} likes, ${fmtNum(d.totalComments)} comments`,
    )
    .join('\n');

  return [
    `Social Video Tracker Report (${dash.month}, since ${dash.sinceDate}):`,
    `- Channels: ${s.totalChannels} (${s.tiktokChannels} TikTok, ${s.facebookChannels} Facebook)`,
    `- Videos: ${fmtNum(s.periodVideos)} (TikTok: ${fmtNum(s.tiktokPeriodVideos)}, FB: ${fmtNum(s.facebookPeriodVideos)})`,
    `- Views: ${fmtNum(s.periodViews)} (Avg ${fmtNum(s.avgViewsPerVideo)}/video)`,
    `- Engagement: ${fmtNum(s.periodLikes)} likes · ${fmtNum(s.periodComments)} comments · ${fmtNum(s.periodShares)} shares`,
    `\nTop creator groups:\n${topGroups}`,
  ].join('\n');
}

async function askAiReport() {
  if (!state.capabilities.message || !state.dashboard) return;
  const prompt = `Analyze our ${state.dashboard.month} TikTok & Facebook channel performance below, highlight top creators, flag underperforming channels, and draft a concise executive summary:\n\n${buildAiSummaryText()}`;
  await app.sendMessage({ role: 'user', content: [{ type: 'text', text: prompt }] });
  state.banner = { kind: 'info', title: 'Sent monthly metrics to chat for AI analysis.' };
  render();
}

async function attachContextToPrompt() {
  if (!state.capabilities.updateModelContext || !state.dashboard) return;
  await app.updateModelContext({ content: [{ type: 'text', text: buildAiSummaryText() }] });
  state.banner = { kind: 'info', title: `Attached ${state.dashboard.month} summary to your next prompt.` };
  render();
}

function parseSheetUrlForUi(url: string): { spreadsheetId: string; gid: string | null } | null {
  const idMatch = url.trim().match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!idMatch) return null;
  const gidMatch = url.trim().match(/[?&#]gid=(\d+)/);
  return { spreadsheetId: idMatch[1], gid: gidMatch ? gidMatch[1] : null };
}

async function requestSheetSyncFromAi(override?: { sheetUrl?: string; sheetTab?: string; replaceExisting?: boolean }) {
  if (!state.capabilities.message || !state.dashboard) return;
  const sheetUrl = (override?.sheetUrl ?? state.dashboard.settings.googleSheetUrl).trim();
  const tabName = (override?.sheetTab ?? state.dashboard.settings.googleSheetTab).trim();
  const info = parseSheetUrlForUi(sheetUrl);

  if (!info) {
    state.banner = {
      kind: 'warning',
      title: 'No Google Sheet URL configured',
      detail: 'Open Scan & Settings → Section 3 and paste your Google Sheet URL first.',
    };
    state.activeTab = 'settings';
    render();
    return;
  }

  const tabInstruction = tabName
    ? `tab "${tabName}"`
    : info.gid
      ? `the tab matching gid=${info.gid} (resolve via gsheets readonly list-sheets ${info.spreadsheetId} --json)`
      : `the first tab`;
  const replaceFlag = override?.replaceExisting ? ' with replaceExisting=true' : '';

  await app.sendMessage({
    role: 'user',
    content: [
      {
        type: 'text',
        text: `Use the Google Sheets plugin to read all rows and hyperlinks from ${tabInstruction} of ${sheetUrl} (spreadsheetId: ${info.spreadsheetId}), then call sync_channels_from_sheet${replaceFlag} to sync channels into Social Video Tracker.`,
      },
    ],
  });
  state.banner = {
    kind: 'info',
    title: 'Requested Google Sheet sync in chat.',
    detail: `Spreadsheet ID: ${info.spreadsheetId}${info.gid ? ` · gid=${info.gid}` : ''}`,
  };
  render();
}

async function requestExportToGoogleSheet(overrideExportUrl?: string) {
  if (!state.capabilities.message || !state.dashboard) return;
  const month = state.month;
  const exportUrl = (overrideExportUrl ?? state.dashboard.settings.exportSheetUrl).trim();
  const info = exportUrl ? parseSheetUrlForUi(exportUrl) : null;

  const targetInstruction = info
    ? `the configured report spreadsheet (${exportUrl}, ID: ${info.spreadsheetId}) — create tab "${month}" if it doesn't exist yet, write the batch JSON into tab "${month}", and format headers`
    : `a new Google Spreadsheet titled "Social Video Tracker - Monthly Reports", rename sheet 0 to "${month}", write the batch JSON, format headers, and save the new URL using prepare_sheet_export(exportSheetUrl)`;

  await app.sendMessage({
    role: 'user',
    content: [
      {
        type: 'text',
        text: `Call prepare_sheet_export(month="${month}") and use the Google Sheets plugin to export the ${month} report into ${targetInstruction}. Keep 1 tab per month (YYYY-MM).`,
      },
    ],
  });

  state.banner = {
    kind: 'info',
    title: `Requested Google Sheets export for tab "${month}".`,
    detail: info ? `Target sheet: ${exportUrl}` : 'A new Google Spreadsheet will be created automatically.',
  };
  render();
}

function renderBudgetBar(dash: DashboardPayload): string {
  const live = dash.apifyLimits;
  const hasLive = live && !live.error && live.monthlyUsageUsd !== null && live.maxMonthlyUsageUsd !== null;
  const used = hasLive ? live.monthlyUsageUsd! : dash.summary.monthSpendUsd;
  const limit = hasLive ? live.maxMonthlyUsageUsd! : dash.summary.monthlyBudgetUsd;
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const fillClass = pct >= 85 ? 'danger' : pct >= 60 ? 'warn' : '';
  const sourceLabel = hasLive
    ? `Live Apify balance (@${esc(live.username ?? 'account')})`
    : 'Local tracked spend (click Test Token in Settings for live Apify balance)';

  return `
    <div class="budget-bar-wrap">
      <div class="budget-header">
        <div><strong>Apify Monthly Budget:</strong> $${used.toFixed(2)} / $${limit.toFixed(2)} (<strong>$${Math.max(0, limit - used).toFixed(2)}</strong> left)</div>
        <div class="muted">${sourceLabel}</div>
      </div>
      <div class="progress-track">
        <div class="progress-fill ${fillClass}" style="width: ${pct}%"></div>
      </div>
    </div>
  `;
}

function renderChannelsTab(dash: DashboardPayload): string {
  if (dash.summary.totalChannels === 0) {
    return `
      <div class="card" style="margin-top:12px;text-align:center;padding:28px 18px;">
        <h3 style="margin-bottom:6px;">No channels added yet</h3>
        <p class="muted" style="margin:0 auto 14px;max-width:480px;">
          Add TikTok or Facebook channel URLs directly, bulk-paste a list, or connect an input Google Sheet in Settings.
        </p>
        <div class="toolbar-group" style="justify-content:center;">
          <button class="btn btn-primary" id="btnOpenAddModal">+ Add / Bulk Import Channels</button>
          <button class="btn" id="btnGoSettingsEmpty">Configure Google Sheet & Apify Token</button>
        </div>
      </div>
    `;
  }

  const failedEnabledCount = dash.channels.filter((r) => r.channel.enabled && r.channel.lastError).length;
  const rowsHtml =
    dash.channels.length === 0
      ? `<tr><td colspan="13" class="muted" style="text-align:center;padding:20px;">No channels match your current filter.</td></tr>`
      : dash.channels
          .map((row, idx) => {
            const c = row.channel;
            const errShort = c.lastError ? c.lastError.split(':')[0] : '';
            const statusHtml = c.lastError
              ? `<div><span class="badge badge-err" title="${esc(c.lastError)}">${esc(errShort || 'Error')}</span></div><div class="muted" style="max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(c.lastError)}">${esc(c.lastError)}</div>`
              : c.lastScannedAt
                ? `<span class="badge badge-ok">${fmtDate(c.lastScannedAt)}</span>`
                : `<span class="badge badge-warn">Not scanned</span>`;

            const isStopped = /stopped|inactive|paused|archived|disabled|失效|ngưng hợp tác/i.test(c.cooperationStatus);

            return `
              <tr style="${!c.enabled ? 'opacity:0.58;' : ''}">
                <td class="num muted">${idx + 1}</td>
                <td><input type="checkbox" data-toggle-channel="${c.id}" ${c.enabled ? 'checked' : ''} title="Enable/disable scanning" /></td>
                <td>
                  <div><button class="link-btn" data-open-videos="${c.id}" data-ch-name="${esc(c.displayName)}" data-ch-handle="${esc(c.handle)}">${esc(c.displayName)}</button></div>
                  <div class="muted"><button class="link-btn muted" data-open-url="${esc(c.url)}">@${esc(c.handle)} ↗</button></div>
                </td>
                <td>
                  <div>${esc(c.ugOwner || '—')}</div>
                  <div class="muted">${esc(c.specialty || '')}</div>
                </td>
                <td><span class="badge ${isStopped ? 'badge-err' : 'badge-tiktok'}" title="${esc(c.cooperationStatus)}">${esc((c.cooperationStatus || 'Active').slice(0, 22))}</span></td>
                <td><span class="badge ${c.platform === 'tiktok' ? 'badge-tiktok' : 'badge-facebook'}">${c.platform === 'tiktok' ? 'TikTok' : 'Facebook'}</span></td>
                <td class="num"><strong>${fmtNum(row.periodVideos)}</strong></td>
                <td class="num"><strong>${fmtNum(row.periodViews)}</strong></td>
                <td class="num muted">${fmtNum(row.periodLikes)} / ${fmtNum(row.periodComments)}</td>
                <td class="num muted">${fmtNum(row.avgViews)}</td>
                <td class="num muted">${fmtNum(c.profileVideoCount)}</td>
                <td>${statusHtml}</td>
                <td class="num"><button class="btn btn-sm btn-danger" data-delete-channel="${c.id}" title="Delete channel">✕</button></td>
              </tr>
            `;
          })
          .join('');

  return `
    <div class="toolbar">
      <div class="toolbar-group">
        <input type="text" id="searchInput" placeholder="Search channel, owner, group, @handle..." value="${esc(state.search)}" style="min-width:220px;" />
        <select id="platformFilter">
          <option value="all" ${state.platformFilter === 'all' ? 'selected' : ''}>All platforms (${dash.summary.totalChannels})</option>
          <option value="tiktok" ${state.platformFilter === 'tiktok' ? 'selected' : ''}>TikTok (${dash.summary.tiktokChannels})</option>
          <option value="facebook" ${state.platformFilter === 'facebook' ? 'selected' : ''}>Facebook (${dash.summary.facebookChannels})</option>
        </select>
      </div>
      <div class="toolbar-group">
        ${failedEnabledCount > 0 ? `<button class="btn btn-sm" id="btnRetryFailed" ${state.busyLabel ? 'disabled' : ''}>Retry ${failedEnabledCount} failed</button>` : ''}
        ${state.capabilities.message ? `<button class="btn btn-sm" id="btnSyncSheet">Sync Google Sheet</button>` : ''}
        <button class="btn btn-sm" id="btnOpenAddModal">+ Add Channels</button>
        <button class="btn btn-sm" id="btnExportChannels">Export CSV</button>
      </div>
    </div>

    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th class="num">#</th>
            <th>Scan</th>
            <th>Channel</th>
            <th>Owner / Category</th>
            <th>Status</th>
            <th>Platform</th>
            <th class="num">Videos (${esc(dash.month)})</th>
            <th class="num">Views (${esc(dash.month)})</th>
            <th class="num">Likes / Cmt</th>
            <th class="num">Avg Views</th>
            <th class="num">Profile Total</th>
            <th>Scan State</th>
            <th></th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
  `;
}

function renderGroupsTab(dash: DashboardPayload): string {
  const rowsHtml =
    dash.doctors.length === 0
      ? `<tr><td colspan="11" class="muted" style="text-align:center;padding:20px;">No creator groups yet.</td></tr>`
      : dash.doctors
          .map(
            (d, idx) => `
          <tr>
            <td class="num muted">${idx + 1}</td>
            <td><strong>${esc(d.doctorGroup)}</strong></td>
            <td class="num">${d.channelsCount}</td>
            <td class="num">${fmtNum(d.tiktokVideos)}</td>
            <td class="num">${fmtNum(d.tiktokViews)}</td>
            <td class="num">${fmtNum(d.facebookVideos)}</td>
            <td class="num">${fmtNum(d.facebookViews)}</td>
            <td class="num"><strong>${fmtNum(d.totalVideos)}</strong></td>
            <td class="num"><strong>${fmtNum(d.totalViews)}</strong></td>
            <td class="num muted">${fmtNum(d.totalLikes)} / ${fmtNum(d.totalComments)}</td>
            <td class="num muted">${fmtNum(d.avgViews)}</td>
          </tr>
        `,
          )
          .join('');

  return `
    <div class="toolbar">
      <div class="muted">Combined TikTok + Facebook rollup for <strong>${esc(dash.month)}</strong> by Creator / Group.</div>
      <button class="btn btn-sm" id="btnExportDoctors">Export Group CSV</button>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th class="num">#</th>
            <th>Creator / Group</th>
            <th class="num">Channels</th>
            <th class="num">TikTok Videos</th>
            <th class="num">TikTok Views</th>
            <th class="num">FB Videos</th>
            <th class="num">FB Views</th>
            <th class="num">Total Videos</th>
            <th class="num">Total Views</th>
            <th class="num">Likes / Cmt</th>
            <th class="num">Avg Views</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
  `;
}

function renderVideosTab(dash: DashboardPayload): string {
  const rowsHtml =
    state.topVideos.length === 0
      ? `<tr><td colspan="7" class="muted" style="text-align:center;padding:24px;">No videos tracked for ${esc(dash.month)} yet.</td></tr>`
      : state.topVideos
          .map(
            (v, idx) => `
          <tr>
            <td class="num muted">${idx + 1}</td>
            <td>
              <div><strong>${esc(v.channelName)}</strong></div>
              <div class="muted">${esc(v.doctorGroup)}</div>
            </td>
            <td><span class="badge ${v.platform === 'tiktok' ? 'badge-tiktok' : 'badge-facebook'}">${v.platform}</span></td>
            <td class="caption-cell" title="${esc(v.caption)}">
              <button class="link-btn" data-open-url="${esc(v.url)}">${esc(v.caption || '(Untitled)')} ↗</button>
            </td>
            <td class="num muted">${fmtDate(v.publishedAt)}</td>
            <td class="num"><strong>${fmtNum(v.views)}</strong></td>
            <td class="num muted">${fmtNum(v.likes)} / ${fmtNum(v.comments)}</td>
          </tr>
        `,
          )
          .join('');

  return `
    <div class="toolbar">
      <span class="muted">Videos published in <strong>${esc(dash.month)}</strong> (${state.topVideos.length})</span>
      <select id="videosSortSelect">
        <option value="views" ${state.videosSortBy === 'views' ? 'selected' : ''}>Sort: Most Viewed</option>
        <option value="published_at" ${state.videosSortBy === 'published_at' ? 'selected' : ''}>Sort: Newest</option>
      </select>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th class="num">#</th>
            <th>Channel</th>
            <th>Platform</th>
            <th>Caption / Link</th>
            <th class="num">Published</th>
            <th class="num">Views</th>
            <th class="num">Likes / Cmt</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
  `;
}

function renderSettingsTab(dash: DashboardPayload): string {
  const s = dash.settings;
  const runsHtml =
    dash.recentRuns.length === 0
      ? `<tr><td colspan="7" class="muted" style="text-align:center;padding:14px;">No scan runs yet.</td></tr>`
      : dash.recentRuns
          .map(
            (r) => `
          <tr>
            <td class="muted">${fmtDateTime(r.startedAt)}</td>
            <td>${esc(r.platform)}</td>
            <td>${esc(r.sinceDate)}</td>
            <td class="num">${r.channelsCount}</td>
            <td class="num">${r.videosInPeriod} / ${r.videosFetched}</td>
            <td class="num">$${r.costUsd.toFixed(4)}</td>
            <td><span class="badge ${r.status === 'succeeded' || r.status === 'dry_run' ? 'badge-ok' : r.status === 'partial' || r.status === 'running' ? 'badge-warn' : 'badge-err'}">${esc(r.status)}</span></td>
          </tr>
        `,
          )
          .join('');

  return `
    <div class="panel-grid">
      <div class="card">
        <h3>1. Run Monthly Scan (Apify Free-Friendly)</h3>
        <div class="form-inline">
          <div class="form-row">
            <label>Scan videos published since</label>
            <input type="date" id="scanSinceDate" value="${esc(state.scanSinceDate)}" />
          </div>
          <div class="form-row">
            <label>Platform</label>
            <select id="scanPlatform">
              <option value="all" ${state.scanPlatform === 'all' ? 'selected' : ''}>All (TikTok + FB)</option>
              <option value="tiktok" ${state.scanPlatform === 'tiktok' ? 'selected' : ''}>TikTok only</option>
              <option value="facebook" ${state.scanPlatform === 'facebook' ? 'selected' : ''}>Facebook only</option>
            </select>
          </div>
        </div>
        <div class="form-inline">
          <div class="form-row">
            <label>Max videos / TikTok channel</label>
            <input type="number" id="scanMaxTiktok" min="1" max="100" value="${state.scanMaxTiktok}" />
          </div>
          <div class="form-row">
            <label>Max reels / Facebook channel</label>
            <input type="number" id="scanMaxFb" min="1" max="100" value="${state.scanMaxFb}" />
          </div>
        </div>
        <div class="form-row">
          <label>Hard cost cap per run — maxTotalChargeUsd ($)</label>
          <input type="number" step="0.1" min="0.1" max="50" id="scanBudgetUsd" value="${state.scanBudgetUsd}" />
          <span class="muted">Keep around $2.20/run to stay comfortably within Apify's $5/mo Free tier (2 runs/mo).</span>
        </div>
        <div class="toolbar-group" style="margin-top:8px;">
          <button class="btn" id="btnDryRun2" ${state.busyLabel ? 'disabled' : ''}>Estimate (Dry Run)</button>
          <button class="btn" id="btnTest3" ${state.busyLabel ? 'disabled' : ''}>Test 3 Channels (~$0.05)</button>
          <button class="btn btn-primary" id="btnRunFullScan" ${state.busyLabel ? 'disabled' : ''}>Scan Now</button>
        </div>
      </div>

      <div class="card">
        <h3>2. Apify Token & Actor Configuration</h3>
        <div class="form-row">
          <label>Apify Personal API Token ${s.hasApifyToken ? `(saved: ${esc(s.apifyTokenMasked)})` : '(not set)'}</label>
          <input type="password" id="apifyTokenInput" placeholder="Paste apify_api_... from console.apify.com/settings/integrations" />
        </div>
        <div class="form-row">
          <label>TikTok Actor ID</label>
          <input type="text" id="tiktokActorInput" value="${esc(s.tiktokActorId)}" />
        </div>
        <div class="form-row">
          <label>Facebook Reels Actor ID</label>
          <input type="text" id="facebookActorInput" value="${esc(s.facebookActorId)}" />
          <div class="toolbar-group" style="margin-top:4px;">
            <button class="btn btn-sm" data-set-fb-actor="alfalfa/facebook-reels-scraper">alfalfa (~$0.9/1k)</button>
            <button class="btn btn-sm" data-set-fb-actor="automation_craft/facebook-reels-scraper">automation_craft (~$0.32/1k)</button>
            <button class="btn btn-sm" data-set-fb-actor="apify/facebook-reels-scraper">apify official (~$3.16/1k)</button>
          </div>
        </div>
        <div class="form-inline">
          <div class="form-row">
            <label>Monthly budget cap ($)</label>
            <input type="number" step="0.5" min="1" id="monthlyBudgetInput" value="${s.monthlyBudgetUsd}" />
          </div>
          <div class="form-row">
            <label>Default per-run cap ($)</label>
            <input type="number" step="0.1" min="0.1" id="perRunBudgetInput" value="${s.perRunBudgetUsd}" />
          </div>
        </div>
        <div class="toolbar-group" style="margin-top:8px;">
          <button class="btn btn-primary" id="btnSaveSettings" ${state.busyLabel ? 'disabled' : ''}>Save Settings</button>
          <button class="btn btn-success" id="btnTestToken" ${state.busyLabel ? 'disabled' : ''}>Verify Token & Balance</button>
        </div>
      </div>

      <div class="card">
        <h3>3. Google Sheets (Input Channels & Monthly Export)</h3>
        <div class="form-row">
          <label>Input Google Sheet URL (source channel list)</label>
          <input type="text" id="googleSheetUrlInput" value="${esc(s.googleSheetUrl)}" placeholder="https://docs.google.com/spreadsheets/d/.../edit?gid=..." />
          ${(() => {
            const parsed = parseSheetUrlForUi(s.googleSheetUrl);
            return parsed
              ? `<span class="muted">Detected ID <code>${esc(parsed.spreadsheetId.slice(0, 14))}…</code>${parsed.gid ? ` · <code>gid=${esc(parsed.gid)}</code>` : ''}</span>`
              : `<span class="muted">Paste any Google Sheet containing TikTok/Facebook URLs (columns auto-detected).</span>`;
          })()}
        </div>
        <div class="form-row">
          <label>Input Tab Name (optional — leave blank to auto-resolve by <code>gid</code>)</label>
          <input type="text" id="googleSheetTabInput" value="${esc(s.googleSheetTab)}" placeholder="Optional tab name" />
        </div>
        <div class="form-row">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
            <input type="checkbox" id="replaceSheetChannelsChk" />
            <span>Disable old channels not present in the new sheet when syncing</span>
          </label>
        </div>
        <div class="toolbar-group" style="margin-top:6px;margin-bottom:12px;">
          <button class="btn" id="btnSaveSheetOnly" ${state.busyLabel ? 'disabled' : ''}>Save Input Sheet</button>
          ${state.capabilities.message ? `<button class="btn btn-primary" id="btnSaveAndSyncSheet" ${state.busyLabel ? 'disabled' : ''}>Save & Sync Now</button>` : ''}
          ${s.googleSheetUrl ? `<button class="btn btn-sm" data-open-url="${esc(s.googleSheetUrl)}">Open Input ↗</button>` : ''}
        </div>

        <hr style="border:none;border-top:1px solid var(--border-1);margin:10px 0;" />

        <div class="form-row">
          <label>Output Report Google Sheet URL (1 tab per month <code>YYYY-MM</code>)</label>
          <input type="text" id="exportSheetUrlInput" value="${esc(s.exportSheetUrl)}" placeholder="Leave blank to auto-create a new spreadsheet on first export" />
        </div>
        <div class="toolbar-group" style="margin-top:6px;">
          <button class="btn" id="btnSaveExportSheet" ${state.busyLabel ? 'disabled' : ''}>Save Output Sheet</button>
          ${state.capabilities.message ? `<button class="btn btn-success" id="btnExportToGoogleSheetSettings" ${state.busyLabel ? 'disabled' : ''}>Export ${esc(dash.month)} Tab</button>` : ''}
          ${s.exportSheetUrl ? `<button class="btn btn-sm" data-open-url="${esc(s.exportSheetUrl)}">Open Report ↗</button>` : ''}
        </div>
      </div>
    </div>

    <div style="margin-top:14px;">
      <h3 style="margin:0 0 8px;font-size:13px;">Recent Scan Runs</h3>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Started</th>
              <th>Platform</th>
              <th>Since</th>
              <th class="num">Channels</th>
              <th class="num">In Period / Total</th>
              <th class="num">Cost</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>${runsHtml}</tbody>
        </table>
      </div>
    </div>
  `;
}

function renderModals(): string {
  if (state.channelModal) {
    const m = state.channelModal;
    const rows =
      m.videos.length === 0
        ? `<tr><td colspan="4" class="muted" style="text-align:center;padding:18px;">No videos tracked in ${esc(state.month)}.</td></tr>`
        : m.videos
            .map(
              (v) => `
            <tr>
              <td class="caption-cell"><button class="link-btn" data-open-url="${esc(v.url)}">${esc(v.caption || v.url)} ↗</button></td>
              <td class="num muted">${fmtDate(v.publishedAt)}</td>
              <td class="num"><strong>${fmtNum(v.views)}</strong></td>
              <td class="num muted">${fmtNum(v.likes)} / ${fmtNum(v.comments)}</td>
            </tr>
          `,
            )
            .join('');

    return `
      <div class="modal-backdrop" id="modalBackdrop">
        <div class="modal">
          <div class="modal-header">
            <div><strong>${esc(m.channelName)}</strong> <span class="muted">@${esc(m.handle)} — ${esc(state.month)}</span></div>
            <button class="btn btn-sm" id="btnCloseModal">Close</button>
          </div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr><th>Video</th><th class="num">Published</th><th class="num">Views</th><th class="num">Likes / Cmt</th></tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>
      </div>
    `;
  }

  if (state.showAddModal) {
    return `
      <div class="modal-backdrop" id="modalBackdrop">
        <div class="modal">
          <div class="modal-header">
            <strong>Add Channel or Bulk Import</strong>
            <button class="btn btn-sm" id="btnCloseModal">Close</button>
          </div>
          <div class="form-row">
            <label>Single channel (TikTok or Facebook URL)</label>
            <input type="text" id="newChannelUrl" placeholder="https://www.tiktok.com/@username or https://www.facebook.com/pagename" />
          </div>
          <div class="form-inline">
            <div class="form-row">
              <label>Display Name (optional)</label>
              <input type="text" id="newChannelName" placeholder="e.g. Jane Doe" />
            </div>
            <div class="form-row">
              <label>Creator / Group (groups TikTok + FB together)</label>
              <input type="text" id="newChannelGroup" placeholder="e.g. Jane Doe" />
            </div>
          </div>
          <button class="btn btn-primary" id="btnSubmitAddChannel">Add Channel</button>
          <hr style="border:none;border-top:1px solid var(--border-1);margin:14px 0;" />
          <div class="form-row">
            <label>Or bulk-paste multiple URLs (one per line)</label>
            <textarea id="bulkChannelsText" rows="5" placeholder="https://www.tiktok.com/@creator1&#10;https://www.facebook.com/creator1"></textarea>
          </div>
          <button class="btn" id="btnSubmitBulkImport">Bulk Import</button>
        </div>
      </div>
    `;
  }

  return '';
}

function render() {
  const root = document.getElementById('app');
  if (!root) return;

  const dash = state.dashboard;
  if (!dash) {
    root.innerHTML = `<div class="loading-shell">${esc(state.busyLabel || 'Loading Social Video Tracker...')}</div>`;
    return;
  }

  const s = dash.summary;
  const tabContent =
    state.activeTab === 'channels'
      ? renderChannelsTab(dash)
      : state.activeTab === 'groups'
        ? renderGroupsTab(dash)
        : state.activeTab === 'videos'
          ? renderVideosTab(dash)
          : renderSettingsTab(dash);

  const tokenWarning = !dash.settings.hasApifyToken
    ? `<div class="banner warning">
         <div><strong>Apify Token not set.</strong> Create a free Apify account ($5/mo credit) and paste your token in <strong>Scan & Settings</strong> to start scanning.</div>
         <button class="btn btn-sm" id="btnGoSettings">Open Settings</button>
       </div>`
    : '';

  const busyBanner = state.busyLabel ? `<div class="banner info"><div>⏳ ${esc(state.busyLabel)}</div></div>` : '';

  const statusBanner = state.banner
    ? `<div class="banner ${state.banner.kind}">
         <div style="width:100%;">
           <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
             <strong>${esc(state.banner.title)}</strong>
             <button class="btn btn-sm" id="btnDismissBanner">✕</button>
           </div>
           ${state.banner.detail ? `<pre>${esc(state.banner.detail)}</pre>` : ''}
         </div>
       </div>`
    : '';

  root.innerHTML = `
    <div class="container">
      <div class="header">
        <div class="title-block">
          <h1>Social Video Tracker</h1>
          <p class="subtitle">Monthly TikTok & Facebook video analytics since ${esc(dash.sinceDate)} — Apify Free-tier ($5/mo) budget controls</p>
        </div>
        <div class="header-controls">
          <input type="month" id="monthPicker" value="${esc(dash.month)}" title="Report month" />
          <button class="btn" id="btnQuickDryRun" ${state.busyLabel ? 'disabled' : ''}>Estimate ($0)</button>
          <button class="btn btn-primary" id="btnQuickScan" ${state.busyLabel ? 'disabled' : ''}>Scan since ${esc(dash.sinceDate)}</button>
          ${state.capabilities.message ? `<button class="btn btn-success" id="btnQuickExportGsheet" ${state.busyLabel ? 'disabled' : ''}>Export Google Sheet</button>` : ''}
          ${state.capabilities.message ? `<button class="btn" id="btnAskAi">AI Summary</button>` : ''}
          ${state.capabilities.updateModelContext ? `<button class="btn" id="btnAttachCtx">Attach Context</button>` : ''}
        </div>
      </div>

      ${tokenWarning}
      ${busyBanner}
      ${statusBanner}
      ${renderBudgetBar(dash)}

      <div class="kpi-grid">
        <div class="kpi-card">
          <div class="kpi-label">Tracked Channels</div>
          <div class="kpi-value">${fmtNum(s.totalChannels)}</div>
          <div class="kpi-sub">${s.tiktokChannels} TikTok · ${s.facebookChannels} Facebook</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Videos (${esc(dash.month)})</div>
          <div class="kpi-value">${fmtNum(s.periodVideos)}</div>
          <div class="kpi-sub">TT: ${fmtNum(s.tiktokPeriodVideos)} · FB: ${fmtNum(s.facebookPeriodVideos)}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Views (${esc(dash.month)})</div>
          <div class="kpi-value">${fmtNum(s.periodViews)}</div>
          <div class="kpi-sub">TT: ${fmtNum(s.tiktokPeriodViews)} · FB: ${fmtNum(s.facebookPeriodViews)}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Likes / Comments</div>
          <div class="kpi-value">${fmtNum(s.periodLikes)} <span class="muted" style="font-size:13px;font-weight:600;">/ ${fmtNum(s.periodComments)}</span></div>
          <div class="kpi-sub">TT: ${fmtNum(s.tiktokPeriodLikes)}❤ · FB: ${fmtNum(s.facebookPeriodLikes)}❤</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Avg Views / Video</div>
          <div class="kpi-value">${fmtNum(s.avgViewsPerVideo)}</div>
          <div class="kpi-sub">Since ${esc(dash.sinceDate)}</div>
        </div>
      </div>

      <div class="tabs">
        <button class="tab-btn ${state.activeTab === 'channels' ? 'active' : ''}" data-tab="channels">Channels (${s.totalChannels})</button>
        <button class="tab-btn ${state.activeTab === 'groups' ? 'active' : ''}" data-tab="groups">By Group (${dash.doctors.length})</button>
        <button class="tab-btn ${state.activeTab === 'videos' ? 'active' : ''}" data-tab="videos">Top Videos</button>
        <button class="tab-btn ${state.activeTab === 'settings' ? 'active' : ''}" data-tab="settings">Scan & Settings</button>
      </div>

      ${tabContent}
      ${renderModals()}
    </div>
  `;

  bindEvents();
}

function bindEvents() {
  document.getElementById('monthPicker')?.addEventListener('change', (e) => {
    const val = (e.target as HTMLInputElement).value;
    if (val) void refreshDashboard({ month: val });
  });
  document.getElementById('btnQuickDryRun')?.addEventListener('click', () => void runScan({ dryRun: true }));
  document.getElementById('btnQuickScan')?.addEventListener('click', () => void runScan({ dryRun: false }));
  document.getElementById('btnQuickExportGsheet')?.addEventListener('click', () => void requestExportToGoogleSheet());
  document.getElementById('btnAskAi')?.addEventListener('click', () => void askAiReport());
  document.getElementById('btnAttachCtx')?.addEventListener('click', () => void attachContextToPrompt());
  document.getElementById('btnGoSettings')?.addEventListener('click', () => {
    state.activeTab = 'settings';
    render();
  });
  document.getElementById('btnGoSettingsEmpty')?.addEventListener('click', () => {
    state.activeTab = 'settings';
    render();
  });
  document.getElementById('btnDismissBanner')?.addEventListener('click', () => {
    state.banner = null;
    render();
  });

  document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const tab = btn.dataset.tab as TabKey;
      state.activeTab = tab;
      if (tab === 'videos') await loadTopVideos();
      render();
    });
  });

  let searchTimer: number | undefined;
  document.getElementById('searchInput')?.addEventListener('input', (e) => {
    const val = (e.target as HTMLInputElement).value;
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => void refreshDashboard({ search: val }), 220);
  });

  document.getElementById('platformFilter')?.addEventListener('change', (e) => {
    void refreshDashboard({ platform: (e.target as HTMLSelectElement).value as 'all' | 'tiktok' | 'facebook' });
  });

  document.getElementById('videosSortSelect')?.addEventListener('change', async (e) => {
    state.videosSortBy = (e.target as HTMLSelectElement).value as 'views' | 'published_at';
    await loadTopVideos();
    render();
  });

  document.getElementById('btnExportChannels')?.addEventListener('click', () => void handleExportCsv('channels'));
  document.getElementById('btnExportDoctors')?.addEventListener('click', () => void handleExportCsv('doctors'));
  document.getElementById('btnOpenAddModal')?.addEventListener('click', () => {
    state.showAddModal = true;
    render();
  });
  document.getElementById('btnRetryFailed')?.addEventListener('click', () => void runScan({ retryFailedOnly: true }));
  document.getElementById('btnSyncSheet')?.addEventListener('click', () => void requestSheetSyncFromAi());

  document.querySelectorAll<HTMLButtonElement>('[data-open-url]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.openUrl) void openExternalUrl(btn.dataset.openUrl);
    });
  });

  document.querySelectorAll<HTMLButtonElement>('[data-open-videos]').forEach((btn) => {
    btn.addEventListener('click', () => {
      void openChannelVideos(Number(btn.dataset.openVideos), btn.dataset.chName ?? '', btn.dataset.chHandle ?? '');
    });
  });

  document.querySelectorAll<HTMLInputElement>('[data-toggle-channel]').forEach((chk) => {
    chk.addEventListener('change', async () => {
      const id = Number(chk.dataset.toggleChannel);
      const row = state.dashboard?.channels.find((c) => c.channel.id === id);
      if (!row) return;
      const res = await callTool<{ dashboard?: DashboardPayload }>('app_upsert_channel', {
        id,
        platform: row.channel.platform,
        handle: row.channel.handle,
        url: row.channel.url,
        displayName: row.channel.displayName,
        doctorGroup: row.channel.doctorGroup,
        enabled: chk.checked,
        month: state.month,
      });
      if (res.structured?.dashboard) {
        syncDashboardState(res.structured.dashboard);
        render();
      }
    });
  });

  document.querySelectorAll<HTMLButtonElement>('[data-delete-channel]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const res = await callTool<{ dashboard?: DashboardPayload }>('app_delete_channel', {
        id: Number(btn.dataset.deleteChannel),
        month: state.month,
      });
      if (res.structured?.dashboard) {
        syncDashboardState(res.structured.dashboard);
        render();
      }
    });
  });

  document.getElementById('scanSinceDate')?.addEventListener('change', (e) => {
    state.scanSinceDate = (e.target as HTMLInputElement).value;
  });
  document.getElementById('scanPlatform')?.addEventListener('change', (e) => {
    state.scanPlatform = (e.target as HTMLSelectElement).value as 'all' | 'tiktok' | 'facebook';
  });
  document.getElementById('scanMaxTiktok')?.addEventListener('change', (e) => {
    state.scanMaxTiktok = Number((e.target as HTMLInputElement).value) || 18;
  });
  document.getElementById('scanMaxFb')?.addEventListener('change', (e) => {
    state.scanMaxFb = Number((e.target as HTMLInputElement).value) || 20;
  });
  document.getElementById('scanBudgetUsd')?.addEventListener('change', (e) => {
    state.scanBudgetUsd = Number((e.target as HTMLInputElement).value) || 2.2;
  });

  document.getElementById('btnDryRun2')?.addEventListener('click', () => void runScan({ dryRun: true }));
  document.getElementById('btnTest3')?.addEventListener('click', () => void runScan({ testFirst3: true }));
  document.getElementById('btnRunFullScan')?.addEventListener('click', () => void runScan({ dryRun: false }));

  document.querySelectorAll<HTMLButtonElement>('[data-set-fb-actor]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = document.getElementById('facebookActorInput') as HTMLInputElement | null;
      if (input && btn.dataset.setFbActor) input.value = btn.dataset.setFbActor;
    });
  });

  document.getElementById('btnSaveSettings')?.addEventListener('click', async () => {
    const tokenVal = (document.getElementById('apifyTokenInput') as HTMLInputElement | null)?.value?.trim();
    const tiktokActorId = (document.getElementById('tiktokActorInput') as HTMLInputElement | null)?.value?.trim();
    const facebookActorId = (document.getElementById('facebookActorInput') as HTMLInputElement | null)?.value?.trim();
    const monthlyBudgetUsd = Number((document.getElementById('monthlyBudgetInput') as HTMLInputElement | null)?.value || '5');
    const perRunBudgetUsd = Number((document.getElementById('perRunBudgetInput') as HTMLInputElement | null)?.value || '2.2');
    const googleSheetUrl = (document.getElementById('googleSheetUrlInput') as HTMLInputElement | null)?.value?.trim();
    const googleSheetTab = (document.getElementById('googleSheetTabInput') as HTMLInputElement | null)?.value?.trim();
    const exportSheetUrl = (document.getElementById('exportSheetUrlInput') as HTMLInputElement | null)?.value?.trim();

    state.busyLabel = 'Saving settings...';
    render();
    try {
      const payload: Record<string, unknown> = {
        tiktokActorId,
        facebookActorId,
        monthlyBudgetUsd,
        perRunBudgetUsd,
        defaultMaxVideosTiktok: state.scanMaxTiktok,
        defaultMaxVideosFacebook: state.scanMaxFb,
        googleSheetUrl,
        googleSheetTab,
        exportSheetUrl,
        month: state.month,
      };
      if (tokenVal) payload.apifyToken = tokenVal;
      const res = await callTool<{ dashboard?: DashboardPayload }>('app_save_settings', payload);
      if (res.structured?.dashboard) syncDashboardState(res.structured.dashboard);
      state.banner = { kind: 'success', title: 'Settings saved.' };
    } finally {
      state.busyLabel = null;
      render();
    }
  });

  document.getElementById('btnSaveSheetOnly')?.addEventListener('click', async () => {
    const googleSheetUrl = (document.getElementById('googleSheetUrlInput') as HTMLInputElement | null)?.value?.trim() ?? '';
    const googleSheetTab = (document.getElementById('googleSheetTabInput') as HTMLInputElement | null)?.value?.trim() ?? '';
    if (googleSheetUrl && !parseSheetUrlForUi(googleSheetUrl)) {
      state.banner = { kind: 'danger', title: 'Invalid Google Sheet URL' };
      render();
      return;
    }
    const res = await callTool<{ dashboard?: DashboardPayload }>('app_save_settings', {
      googleSheetUrl,
      googleSheetTab,
      month: state.month,
    });
    if (res.structured?.dashboard) syncDashboardState(res.structured.dashboard);
    state.banner = { kind: 'success', title: 'Input Google Sheet URL saved.' };
    render();
  });

  document.getElementById('btnSaveAndSyncSheet')?.addEventListener('click', async () => {
    const googleSheetUrl = (document.getElementById('googleSheetUrlInput') as HTMLInputElement | null)?.value?.trim() ?? '';
    const googleSheetTab = (document.getElementById('googleSheetTabInput') as HTMLInputElement | null)?.value?.trim() ?? '';
    const replaceExisting = Boolean((document.getElementById('replaceSheetChannelsChk') as HTMLInputElement | null)?.checked);
    if (!parseSheetUrlForUi(googleSheetUrl)) {
      state.banner = { kind: 'danger', title: 'Invalid Google Sheet URL' };
      render();
      return;
    }
    const res = await callTool<{ dashboard?: DashboardPayload }>('app_save_settings', {
      googleSheetUrl,
      googleSheetTab,
      month: state.month,
    });
    if (res.structured?.dashboard) syncDashboardState(res.structured.dashboard);
    await requestSheetSyncFromAi({ sheetUrl: googleSheetUrl, sheetTab: googleSheetTab, replaceExisting });
  });

  document.getElementById('btnSaveExportSheet')?.addEventListener('click', async () => {
    const exportSheetUrl = (document.getElementById('exportSheetUrlInput') as HTMLInputElement | null)?.value?.trim() ?? '';
    if (exportSheetUrl && !parseSheetUrlForUi(exportSheetUrl)) {
      state.banner = { kind: 'danger', title: 'Invalid report Google Sheet URL' };
      render();
      return;
    }
    const res = await callTool<{ dashboard?: DashboardPayload }>('app_save_settings', {
      exportSheetUrl,
      month: state.month,
    });
    if (res.structured?.dashboard) syncDashboardState(res.structured.dashboard);
    state.banner = { kind: 'success', title: 'Output Google Sheet URL saved.' };
    render();
  });

  document.getElementById('btnExportToGoogleSheetSettings')?.addEventListener('click', async () => {
    const exportSheetUrl = (document.getElementById('exportSheetUrlInput') as HTMLInputElement | null)?.value?.trim() ?? '';
    if (exportSheetUrl && !parseSheetUrlForUi(exportSheetUrl)) {
      state.banner = { kind: 'danger', title: 'Invalid report Google Sheet URL' };
      render();
      return;
    }
    const res = await callTool<{ dashboard?: DashboardPayload }>('app_save_settings', {
      exportSheetUrl,
      month: state.month,
    });
    if (res.structured?.dashboard) syncDashboardState(res.structured.dashboard);
    await requestExportToGoogleSheet(exportSheetUrl);
  });

  document.getElementById('btnTestToken')?.addEventListener('click', async () => {
    const tokenVal = (document.getElementById('apifyTokenInput') as HTMLInputElement | null)?.value?.trim();
    state.busyLabel = 'Verifying Apify token & balance...';
    render();
    try {
      const res = await callTool<{ limits?: DashboardPayload['apifyLimits'] }>('app_test_apify_token', {
        apifyToken: tokenVal || undefined,
      });
      await refreshDashboard();
      state.banner = {
        kind: res.isError || res.structured?.limits?.error ? 'danger' : 'success',
        title: res.isError ? 'Apify verification failed' : 'Apify Token Verified',
        detail: res.text,
      };
    } finally {
      state.busyLabel = null;
      render();
    }
  });

  document.getElementById('btnCloseModal')?.addEventListener('click', () => {
    state.channelModal = null;
    state.showAddModal = false;
    render();
  });
  document.getElementById('modalBackdrop')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) {
      state.channelModal = null;
      state.showAddModal = false;
      render();
    }
  });

  document.getElementById('btnSubmitAddChannel')?.addEventListener('click', async () => {
    const urlOrHandle = (document.getElementById('newChannelUrl') as HTMLInputElement | null)?.value?.trim();
    const displayName = (document.getElementById('newChannelName') as HTMLInputElement | null)?.value?.trim();
    const doctorGroup = (document.getElementById('newChannelGroup') as HTMLInputElement | null)?.value?.trim();
    if (!urlOrHandle) return;
    const res = await callTool<{ dashboard?: DashboardPayload }>('app_upsert_channel', {
      urlOrHandle,
      displayName: displayName || undefined,
      doctorGroup: doctorGroup || undefined,
      month: state.month,
    });
    if (res.isError) {
      state.banner = { kind: 'danger', title: 'Could not add channel', detail: res.text };
    } else if (res.structured?.dashboard) {
      syncDashboardState(res.structured.dashboard);
      state.showAddModal = false;
      state.banner = { kind: 'success', title: 'Channel added.' };
    }
    render();
  });

  document.getElementById('btnSubmitBulkImport')?.addEventListener('click', async () => {
    const rawText = (document.getElementById('bulkChannelsText') as HTMLTextAreaElement | null)?.value ?? '';
    if (!rawText.trim()) return;
    const res = await callTool<{ importedCount: number; dashboard?: DashboardPayload }>('app_import_channels_bulk', {
      rawText,
      month: state.month,
    });
    if (res.structured?.dashboard) {
      syncDashboardState(res.structured.dashboard);
      state.showAddModal = false;
      state.banner = { kind: 'success', title: `Imported ${res.structured.importedCount} channels.` };
      render();
    }
  });
}

app.ontoolinput = () => {
  if (!state.dashboard) {
    state.busyLabel = 'Loading dashboard...';
    render();
  }
};

app.ontoolresult = (result) => {
  const sc = result.structuredContent as DashboardPayload | undefined;
  if (sc && sc.summary && Array.isArray(sc.channels)) {
    syncDashboardState(sc);
    state.busyLabel = null;
    render();
  }
};

app.onhostcontextchanged = (ctx) => {
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
};

async function bootstrap() {
  await app.connect();
  const ctx = app.getHostContext();
  if (ctx?.theme) applyDocumentTheme(ctx.theme);
  if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);

  const caps = app.getHostCapabilities();
  state.capabilities = {
    message: Boolean(caps?.message),
    updateModelContext: Boolean(caps?.updateModelContext),
    openLinks: Boolean(caps?.openLinks),
  };

  if (!state.dashboard) await refreshDashboard();
  else render();

  if (state.dashboard?.activeRuns && state.dashboard.activeRuns.length > 0) {
    void pollRunningScansOnce();
  }
}

void bootstrap();
