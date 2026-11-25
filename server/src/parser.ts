import type { ChannelMonthlyRow, DoctorMonthlyRow, Platform } from './types.js';

export interface ParsedChannelInput {
  platform: Platform;
  handle: string;
  url: string;
  displayName: string;
  doctorGroup: string;
}

export interface ParsedSheetUrlInfo {
  spreadsheetId: string;
  gid: string | null;
}

export interface SheetRowChannel {
  platform: Platform;
  handle: string;
  url: string;
  displayName: string;
  doctorGroup: string;
  ugOwner: string;
  specialty: string;
  cooperationStatus: string;
  sheetRow: number;
  enabled: boolean;
}

export function getCurrentMonth(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

export function getMonthStartDate(month?: string, now = new Date()): string {
  const target = month && /^\d{4}-\d{2}$/.test(month) ? month : getCurrentMonth(now);
  return `${target}-01`;
}

export function normalizeDateIso(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d{10,13}$/.test(trimmed)) {
      const num = Number(trimmed);
      const ms = trimmed.length <= 10 ? num * 1000 : num;
      const d = new Date(ms);
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    }
    const d = new Date(trimmed);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

export function extractMonthFromIso(iso: string | null): string | null {
  if (!iso) return null;
  const match = iso.match(/^(\d{4}-\d{2})/);
  return match ? match[1] : null;
}

export function extractGoogleSheetInfo(url: string): ParsedSheetUrlInfo | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  const idMatch = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!idMatch) return null;
  const gidMatch = trimmed.match(/[?&#]gid=(\d+)/);
  return {
    spreadsheetId: idMatch[1],
    gid: gidMatch ? gidMatch[1] : null,
  };
}

export function parseChannelLine(rawLine: string): ParsedChannelInput | null {
  const line = rawLine.trim();
  if (!line || line === '/' || !/https?:\/\/|@/i.test(line)) {
    return null;
  }

  let label = '';
  let targetUrl = line;

  const mdMatch = line.match(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/);
  if (mdMatch) {
    const rawLabel = mdMatch[1].trim();
    const linkUrl = mdMatch[2].trim();
    if (/^https?:\/\/(www\.)?facebook\.com\/(?!share\/)/i.test(rawLabel)) {
      targetUrl = rawLabel;
    } else {
      label = rawLabel.replace(/\s*\|\s*TikTok$/i, '').trim();
      targetUrl = linkUrl;
    }
  } else {
    const urlMatch = line.match(/https?:\/\/[^\s)]+/i);
    if (urlMatch) {
      targetUrl = urlMatch[0];
    } else if (line.startsWith('@')) {
      const handle = line.slice(1).split(/[/?\s]/)[0];
      if (!handle) return null;
      return {
        platform: 'tiktok',
        handle,
        url: `https://www.tiktok.com/@${handle}`,
        displayName: handle,
        doctorGroup: handle,
      };
    } else {
      return null;
    }
  }

  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase();

  if (host.includes('tiktok.com')) {
    const match = parsed.pathname.match(/\/@([^/?#]+)/);
    if (!match) return null;
    const handle = match[1].trim();
    const displayName = label || handle;
    return {
      platform: 'tiktok',
      handle,
      url: `https://www.tiktok.com/@${handle}`,
      displayName,
      doctorGroup: displayName,
    };
  }

  if (host.includes('facebook.com') || host.includes('fb.com')) {
    const profileId = parsed.searchParams.get('id');
    if (parsed.pathname.includes('profile.php') && profileId) {
      const handle = profileId.trim();
      const displayName = label || `FB ${handle}`;
      return {
        platform: 'facebook',
        handle,
        url: `https://www.facebook.com/profile.php?id=${handle}`,
        displayName,
        doctorGroup: displayName,
      };
    }

    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length === 0) return null;
    const first = segments[0];
    const handle = first === 'share' && segments[1] ? `share_${segments[1]}` : first;
    const cleanUrl = first === 'share' ? targetUrl : `https://www.facebook.com/${first}`;
    const displayName = label || handle;
    return {
      platform: 'facebook',
      handle,
      url: cleanUrl,
      displayName,
      doctorGroup: displayName,
    };
  }

  return null;
}

export function parseBulkChannelText(text: string): ParsedChannelInput[] {
  const results: ParsedChannelInput[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const item = parseChannelLine(line);
    if (!item) continue;
    const key = `${item.platform}:${item.handle.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(item);
  }
  return results;
}

function findHeaderCol(headers: string[], pattern: RegExp): number {
  return headers.findIndex((h) => pattern.test(h));
}

export function parseGoogleSheetRows(rows: unknown[][]): SheetRowChannel[] {
  const results: SheetRowChannel[] = [];
  const seen = new Set<string>();
  if (rows.length === 0) return results;

  const firstRow = Array.isArray(rows[0]) ? rows[0].map((c) => String(c ?? '').trim()) : [];
  const firstRowHasUrls = firstRow.some((c) => /tiktok\.com|facebook\.com|fb\.com/i.test(c));
  const startRowIndex = firstRowHasUrls ? 0 : 1;

  const nameCol = firstRowHasUrls
    ? 0
    : Math.max(0, findHeaderCol(firstRow, /creator|channel|group|name|doctor|họ tên|tên|医生|\bip\b/i));
  const ownerCol = firstRowHasUrls ? -1 : findHeaderCol(firstRow, /owner|manager|team|pic|\bug\b|\bpg\b|\beo\b|phụ trách/i);
  const categoryCol = firstRowHasUrls ? -1 : findHeaderCol(firstRow, /category|niche|topic|specialty|chuyên khoa|专科/i);
  const aliasCol = firstRowHasUrls ? -1 : findHeaderCol(firstRow, /alias|brand|org|clinic|医院|phòng khám/i);
  const statusCol = firstRowHasUrls ? -1 : findHeaderCol(firstRow, /status|state|trạng thái|hợp tác|合作状态/i);
  const extraCol = firstRowHasUrls ? -1 : findHeaderCol(firstRow, /extra|other|secondary|khác|其他/i);

  for (let i = startRowIndex; i < rows.length; i++) {
    const row = rows[i];
    if (!Array.isArray(row)) continue;

    const rawName = String(row[nameCol] ?? '').trim();
    const ugOwner = ownerCol >= 0 ? String(row[ownerCol] ?? '').trim() : '';
    const specialty = categoryCol >= 0 ? String(row[categoryCol] ?? '').trim() : '';
    const aliasVal = aliasCol >= 0 ? String(row[aliasCol] ?? '').trim() : '';
    const status = statusCol >= 0 ? String(row[statusCol] ?? '').trim() : '';

    const isStopped = /stopped|inactive|paused|archived|disabled|失效|ngưng hợp tác/i.test(status);
    const genericName = !rawName || /^(koc|kol|offical|official)$/i.test(rawName);
    const cleanAlias = aliasVal.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    const groupFallback = genericName ? cleanAlias || rawName || `Row ${i + 1}` : rawName;

    for (let ci = 0; ci < row.length; ci++) {
      const cell = String(row[ci] ?? '').trim();
      if (!cell || cell === '/' || !/tiktok\.com|facebook\.com|fb\.com/i.test(cell)) continue;

      for (const line of cell.split(/[\r\n]+/)) {
        const parsed = parseChannelLine(line);
        if (!parsed) continue;

        const key = `${parsed.platform}:${parsed.handle.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const doctorGroup = groupFallback || parsed.displayName;
        const isExtra = extraCol >= 0 && ci === extraCol;
        const suffix = isExtra ? ' (Secondary)' : parsed.platform === 'facebook' ? ' (FB)' : '';

        results.push({
          platform: parsed.platform,
          handle: parsed.handle,
          url: parsed.url,
          displayName: `${doctorGroup}${suffix}`,
          doctorGroup,
          ugOwner,
          specialty,
          cooperationStatus: status,
          sheetRow: i + 1,
          enabled: !isStopped,
        });
      }
    }
  }

  return results;
}

function escapeCsvCell(value: string | number | null | undefined): string {
  const str = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function buildMonthlyExportSheetRows(dash: {
  month: string;
  sinceDate: string;
  summary: {
    totalChannels: number;
    enabledChannels: number;
    tiktokChannels: number;
    facebookChannels: number;
    periodVideos: number;
    periodViews: number;
    periodLikes: number;
    periodComments: number;
    periodShares: number;
    tiktokPeriodVideos: number;
    tiktokPeriodViews: number;
    facebookPeriodVideos: number;
    facebookPeriodViews: number;
    avgViewsPerVideo: number;
    monthSpendUsd: number;
  };
  channels: ChannelMonthlyRow[];
  doctors: DoctorMonthlyRow[];
}): Array<Array<string | number>> {
  const s = dash.summary;
  const rows: Array<Array<string | number>> = [];
  rows.push([`SOCIAL VIDEO TRACKER REPORT — ${dash.month}`]);
  rows.push([
    `Since: ${dash.sinceDate}`,
    `Updated: ${new Date().toISOString()}`,
    `Channels: ${s.totalChannels} (${s.tiktokChannels} TikTok, ${s.facebookChannels} FB)`,
    `Active: ${s.enabledChannels}`,
    `Apify Cost: $${s.monthSpendUsd.toFixed(2)}`,
  ]);
  rows.push([
    'MONTHLY SUMMARY',
    `Videos: ${s.periodVideos}`,
    `TikTok Videos: ${s.tiktokPeriodVideos}`,
    `FB Videos: ${s.facebookPeriodVideos}`,
    `Views: ${s.periodViews}`,
    `TikTok Views: ${s.tiktokPeriodViews}`,
    `FB Views: ${s.facebookPeriodViews}`,
    `Avg Views/Video: ${s.avgViewsPerVideo}`,
    `Likes: ${s.periodLikes}`,
    `Comments: ${s.periodComments}`,
    `Shares: ${s.periodShares}`,
  ]);
  rows.push([]);
  rows.push([
    '#',
    'Creator / Group',
    'Owner / Team',
    'Category',
    'Status',
    'Channel Name',
    'Platform',
    'Handle',
    'URL',
    `Videos (${dash.month})`,
    `Views (${dash.month})`,
    'Avg Views',
    'Likes',
    'Comments',
    'Shares',
    'Profile Total Videos',
    'Last Scanned',
    'Scan Status',
  ]);

  dash.channels.forEach((r, idx) => {
    const c = r.channel;
    const scanStatus = c.lastError
      ? c.lastError
      : !c.enabled
        ? 'Disabled'
        : c.lastScannedAt
          ? 'OK'
          : 'Not scanned';
    rows.push([
      idx + 1,
      c.doctorGroup,
      c.ugOwner,
      c.specialty,
      c.cooperationStatus,
      c.displayName,
      c.platform === 'tiktok' ? 'TikTok' : 'Facebook',
      c.handle,
      c.url,
      r.periodVideos,
      r.periodViews,
      r.avgViews,
      r.periodLikes,
      r.periodComments,
      r.periodShares,
      c.profileVideoCount ?? '',
      c.lastScannedAt ? c.lastScannedAt.slice(0, 10) : '',
      scanStatus,
    ]);
  });

  rows.push([]);
  rows.push([`GROUP / CREATOR ROLLUP — ${dash.month}`]);
  rows.push([
    '#',
    'Creator / Group',
    'Channels',
    'TikTok Videos',
    'TikTok Views',
    'FB Videos',
    'FB Views',
    'Total Videos',
    'Total Views',
    'Avg Views',
    'Total Likes',
    'Total Comments',
    'Total Shares',
  ]);

  dash.doctors.forEach((d, idx) => {
    rows.push([
      idx + 1,
      d.doctorGroup,
      d.channelsCount,
      d.tiktokVideos,
      d.tiktokViews,
      d.facebookVideos,
      d.facebookViews,
      d.totalVideos,
      d.totalViews,
      d.avgViews,
      d.totalLikes,
      d.totalComments,
      d.totalShares,
    ]);
  });

  return rows;
}

export function buildChannelsCsv(month: string, rows: ChannelMonthlyRow[]): string {
  const header = [
    'Month',
    'Creator / Group',
    'Owner / Team',
    'Category',
    'Status',
    'Channel Name',
    'Platform',
    'Handle',
    'URL',
    'Videos',
    'Views',
    'Avg Views',
    'Likes',
    'Comments',
    'Shares',
    'Profile Total Videos',
    'Last Scanned',
    'Last Error',
  ];

  const lines = [header.map(escapeCsvCell).join(',')];
  for (const row of rows) {
    lines.push(
      [
        month,
        row.channel.doctorGroup,
        row.channel.ugOwner,
        row.channel.specialty,
        row.channel.cooperationStatus,
        row.channel.displayName,
        row.channel.platform,
        row.channel.handle,
        row.channel.url,
        row.periodVideos,
        row.periodViews,
        row.avgViews,
        row.periodLikes,
        row.periodComments,
        row.periodShares,
        row.channel.profileVideoCount ?? '',
        row.channel.lastScannedAt ?? '',
        row.channel.lastError ?? '',
      ]
        .map(escapeCsvCell)
        .join(','),
    );
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

export function buildDoctorsCsv(month: string, rows: DoctorMonthlyRow[]): string {
  const header = [
    'Month',
    'Creator / Group',
    'Channels',
    'TikTok Videos',
    'TikTok Views',
    'FB Videos',
    'FB Views',
    'Total Videos',
    'Total Views',
    'Avg Views',
    'Total Likes',
    'Total Comments',
    'Total Shares',
  ];
  const lines = [header.map(escapeCsvCell).join(',')];
  for (const row of rows) {
    lines.push(
      [
        month,
        row.doctorGroup,
        row.channelsCount,
        row.tiktokVideos,
        row.tiktokViews,
        row.facebookVideos,
        row.facebookViews,
        row.totalVideos,
        row.totalViews,
        row.avgViews,
        row.totalLikes,
        row.totalComments,
        row.totalShares,
      ]
        .map(escapeCsvCell)
        .join(','),
    );
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

export function maskSecret(secret: string): string {
  const trimmed = secret.trim();
  if (!trimmed) return '';
  if (trimmed.length <= 10) return '••••••';
  return `${trimmed.slice(0, 6)}••••${trimmed.slice(-4)}`;
}
