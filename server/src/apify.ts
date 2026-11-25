import { extractMonthFromIso, normalizeDateIso } from './parser.js';
import type { ApifyAccountLimits, Channel, Platform, VideoRecord } from './types.js';

const APIFY_BASE = 'https://api.apify.com/v2';

export interface NormalizedActorItem {
  videoId: string;
  platform: Platform;
  channelMatchKeys: string[];
  url: string;
  caption: string;
  publishedAt: string | null;
  publishedMonth: string | null;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  durationSec: number | null;
  thumbnailUrl: string | null;
  profileVideoCount: number | null;
  profileFollowers: number | null;
}

export interface NormalizedActorError {
  platform: Platform;
  channelMatchKeys: string[];
  errorCode: string;
  errorMessage: string;
}

export interface ApifyRunStartResult {
  actorId: string;
  apifyRunId: string;
  datasetId: string;
  status: string;
}

export interface ApifyRunPollResult {
  apifyRunId: string;
  datasetId: string;
  status: string;
  usageTotalUsd: number;
}

export interface ApifyRunResult {
  actorId: string;
  apifyRunId: string;
  datasetId: string;
  status: string;
  usageTotalUsd: number;
  items: Record<string, unknown>[];
}

function asNumber(val: unknown): number {
  if (typeof val === 'number' && Number.isFinite(val)) return Math.max(0, Math.round(val));
  if (typeof val === 'string') {
    const cleaned = val.trim().replace(/,/g, '');
    const suffixMatch = cleaned.match(/^([\d.]+)\s*([kmb])$/i);
    if (suffixMatch) {
      const base = Number(suffixMatch[1]);
      const mult =
        suffixMatch[2].toLowerCase() === 'b'
          ? 1_000_000_000
          : suffixMatch[2].toLowerCase() === 'm'
            ? 1_000_000
            : 1_000;
      return Math.max(0, Math.round(base * mult));
    }
    const n = Number(cleaned);
    if (Number.isFinite(n)) return Math.max(0, Math.round(n));
  }
  return 0;
}

function asNullableNumber(val: unknown): number | null {
  if (val === null || val === undefined || val === '') return null;
  const n = asNumber(val);
  return Number.isFinite(n) ? n : null;
}

function asString(val: unknown): string {
  return typeof val === 'string' ? val.trim() : '';
}

function actorIdToPath(actorId: string): string {
  return encodeURIComponent(actorId.replace('/', '~'));
}

export function buildTiktokActorInput(channels: Channel[], sinceDate: string, maxVideosPerChannel: number) {
  return {
    profiles: channels.map((c) => c.handle),
    resultsPerPage: maxVideosPerChannel,
    oldestPostDateUnified: sinceDate,
    shouldDownloadVideos: false,
    shouldDownloadCovers: false,
    shouldDownloadSubtitles: false,
    shouldDownloadSlideshowImages: false,
  };
}

export function buildFacebookActorInput(channels: Channel[], maxVideosPerChannel: number) {
  return {
    startUrls: channels.map((c) => ({ url: c.url })),
    resultsLimit: maxVideosPerChannel,
    maxPosts: maxVideosPerChannel,
  };
}

export function estimateCostUsd(tiktokChannels: number, facebookChannels: number, maxTiktok: number, maxFb: number) {
  // Conservative Free-tier estimate: TikTok ~$3.00/1k, FB community ~$0.90/1k
  // Assuming average channels post ~55% of cap since start of month
  const expectedTiktokVideos = Math.round(tiktokChannels * maxTiktok * 0.55);
  const expectedFbVideos = Math.round(facebookChannels * maxFb * 0.55);
  const maxTiktokVideos = tiktokChannels * maxTiktok;
  const maxFbVideos = facebookChannels * maxFb;

  const estimatedUsd = Number(((expectedTiktokVideos * 3.0) / 1000 + (expectedFbVideos * 0.9) / 1000).toFixed(2));
  const worstCaseUsd = Number(((maxTiktokVideos * 3.0) / 1000 + (maxFbVideos * 0.9) / 1000).toFixed(2));

  return {
    expectedTiktokVideos,
    expectedFbVideos,
    maxTiktokVideos,
    maxFbVideos,
    estimatedUsd,
    worstCaseUsd,
  };
}

export interface NormalizedProfileNote {
  platform: Platform;
  handle: string;
  profileVideoCount: number | null;
  profileFollowers: number | null;
  note: string;
}

export function extractTiktokProfileNote(raw: Record<string, unknown>): NormalizedProfileNote | null {
  if (!raw.note || raw.error || raw.errorCode) return null;
  const authorMeta = (raw.authorMeta ?? raw.author ?? {}) as Record<string, unknown>;
  const handle = asString(authorMeta.name || authorMeta.uniqueId || raw.input).replace(/^@/, '');
  if (!handle) return null;
  return {
    platform: 'tiktok',
    handle: handle.toLowerCase(),
    profileVideoCount: asNullableNumber(authorMeta.video ?? authorMeta.videoCount),
    profileFollowers: asNullableNumber(authorMeta.fans ?? authorMeta.followerCount),
    note: asString(raw.note),
  };
}

export function extractTiktokError(raw: Record<string, unknown>): NormalizedActorError | null {
  const err = asString(raw.error);
  const errCode = asString(raw.errorCode);
  if (!err && !errCode) return null;

  const keys: string[] = [];
  const inputHandle = asString(raw.input).replace(/^@/, '');
  if (inputHandle) keys.push(inputHandle.toLowerCase());
  const urlHandle = asString(raw.url).match(/\/@([^/?#]+)/)?.[1];
  if (urlHandle) keys.push(urlHandle.toLowerCase());

  return {
    platform: 'tiktok',
    channelMatchKeys: Array.from(new Set(keys)),
    errorCode: errCode || 'ERROR',
    errorMessage: err || errCode,
  };
}

export function normalizeTiktokItem(raw: Record<string, unknown>): NormalizedActorItem | null {
  // Ignore error / placeholder rows emitted by Clockworks (e.g. NOT_FOUND or NO_VIDEOS)
  if (raw.error || raw.errorCode || raw.note) return null;

  const authorMeta = (raw.authorMeta ?? raw.author ?? {}) as Record<string, unknown>;
  const videoMeta = (raw.videoMeta ?? raw.video ?? {}) as Record<string, unknown>;

  const authorHandle = asString(authorMeta.name || authorMeta.uniqueId || raw.authorHandle || raw.input);
  const webVideoUrl = asString(raw.webVideoUrl || raw.url || raw.videoUrl);
  const rawId = asString(raw.id || raw.awemeId || raw.videoId) || (webVideoUrl.match(/video\/(\d+)/)?.[1] ?? '');

  if (!rawId) return null;

  const publishedAt =
    normalizeDateIso(raw.createTimeISO) ??
    normalizeDateIso(raw.createTime) ??
    normalizeDateIso(raw.createdAt) ??
    normalizeDateIso(raw.timestamp);

  const matchKeys: string[] = [];
  if (authorHandle) matchKeys.push(authorHandle.replace(/^@/, '').toLowerCase());
  const urlHandle = webVideoUrl.match(/\/@([^/?#]+)/)?.[1];
  if (urlHandle) matchKeys.push(urlHandle.toLowerCase());

  return {
    videoId: `tiktok:${rawId}`,
    platform: 'tiktok',
    channelMatchKeys: Array.from(new Set(matchKeys)),
    url: webVideoUrl || (authorHandle ? `https://www.tiktok.com/@${authorHandle}/video/${rawId}` : ''),
    caption: asString(raw.text || raw.desc || raw.caption).slice(0, 300),
    publishedAt,
    publishedMonth: extractMonthFromIso(publishedAt),
    views: asNumber(raw.playCount ?? raw.views ?? raw.viewCount ?? (raw.stats as Record<string, unknown> | undefined)?.playCount),
    likes: asNumber(raw.diggCount ?? raw.likes ?? raw.likeCount ?? (raw.stats as Record<string, unknown> | undefined)?.diggCount),
    comments: asNumber(raw.commentCount ?? raw.comments ?? (raw.stats as Record<string, unknown> | undefined)?.commentCount),
    shares: asNumber(raw.shareCount ?? raw.shares ?? (raw.stats as Record<string, unknown> | undefined)?.shareCount),
    durationSec: asNullableNumber(videoMeta.duration ?? raw.duration),
    thumbnailUrl: asString(videoMeta.coverUrl || videoMeta.originalCoverUrl || raw.coverUrl) || null,
    profileVideoCount: asNullableNumber(authorMeta.video ?? authorMeta.videoCount),
    profileFollowers: asNullableNumber(authorMeta.fans ?? authorMeta.followerCount),
  };
}

function extractFacebookMatchKeys(raw: Record<string, unknown>): string[] {
  const keys: string[] = [];
  const candidates = [
    asString(raw.inputUrl),
    asString(raw.facebookUrl),
    asString(raw.pageUrl),
    asString(raw.userUrl),
    asString(raw.profileUrl),
    asString(raw.ownerUrl),
    asString(raw.pageName),
    asString(raw.username),
    asString(raw.ownerName),
    asString(raw.pageId),
    asString(raw.userId),
    asString(raw.ownerId),
    asString((raw.user as Record<string, unknown> | undefined)?.id),
    asString((raw.user as Record<string, unknown> | undefined)?.name),
  ].filter(Boolean);

  for (const val of candidates) {
    if (val.startsWith('http')) {
      try {
        const u = new URL(val);
        const idParam = u.searchParams.get('id');
        if (idParam) keys.push(idParam.toLowerCase());
        const seg = u.pathname.split('/').filter(Boolean)[0];
        if (seg && seg !== 'profile.php' && seg !== 'reel' && seg !== 'reels') {
          keys.push(seg.toLowerCase());
        }
      } catch {
        // ignore malformed URL
      }
    } else {
      keys.push(val.toLowerCase());
    }
  }
  return Array.from(new Set(keys));
}

export function normalizeFacebookItem(raw: Record<string, unknown>): NormalizedActorItem | null {
  if (raw.error || raw.errorCode) return null;

  const reelUrl = asString(raw.topLevelReelUrl || raw.url || raw.reelUrl || raw.topLevelUrl || raw.postUrl || raw.videoUrl || raw.permalink);
  const rawId =
    asString(raw.reelId || raw.post_id || raw.postId || raw.videoId || raw.id) ||
    (reelUrl.match(/reel\/(\d+)/)?.[1] ?? '') ||
    (reelUrl.match(/videos\/(\d+)/)?.[1] ?? '');

  if (!rawId && !reelUrl) return null;

  const publishedAt =
    normalizeDateIso(raw.time) ??
    normalizeDateIso(raw.timestamp) ??
    normalizeDateIso(raw.creation_time) ??
    normalizeDateIso(raw.creationTime) ??
    normalizeDateIso(raw.createdAt) ??
    normalizeDateIso(raw.publishedTime) ??
    normalizeDateIso(raw.date);

  const views = asNumber(
    raw.playCount ??
      raw.play_count ??
      raw.playCountRounded ??
      raw.play_count_reduced ??
      raw.videoPlayCount ??
      raw.views ??
      raw.viewsCount ??
      raw.viewCount ??
      raw.plays ??
      raw.videoViewCount,
  );

  const messageText =
    typeof raw.message === 'object' && raw.message !== null
      ? asString((raw.message as Record<string, unknown>).text)
      : asString(raw.message);

  return {
    videoId: `facebook:${rawId || reelUrl}`,
    platform: 'facebook',
    channelMatchKeys: extractFacebookMatchKeys(raw),
    url: reelUrl,
    caption: asString(raw.text || raw.caption || raw.description || messageText || raw.title).slice(0, 300),
    publishedAt,
    publishedMonth: extractMonthFromIso(publishedAt),
    views,
    likes: asNumber(raw.likes ?? raw.likesCount ?? raw.reactionsCount ?? raw.likeCount),
    comments: asNumber(raw.comments ?? raw.commentsCount ?? raw.commentCount),
    shares: asNumber(raw.shares ?? raw.sharesCount ?? raw.sharesCountRounded ?? raw.shareCount),
    durationSec: asNullableNumber(raw.durationSeconds ?? raw.duration ?? raw.lengthInSeconds ?? raw.videoDuration),
    thumbnailUrl: asString(raw.thumbnailUrl || raw.thumbnail || raw.imageUrl) || null,
    profileVideoCount: null,
    profileFollowers: asNullableNumber(raw.followers ?? raw.pageFollowers),
  };
}

export function matchItemToChannel(item: NormalizedActorItem, channels: Channel[]): Channel | null {
  const samePlatform = channels.filter((c) => c.platform === item.platform);
  for (const key of item.channelMatchKeys) {
    const found = samePlatform.find(
      (c) =>
        c.handle.toLowerCase() === key ||
        c.displayName.toLowerCase() === key ||
        c.url.toLowerCase().includes(key),
    );
    if (found) return found;
  }
  return null;
}

export function mapNormalizedToVideoRecord(
  item: NormalizedActorItem,
  channelId: number,
): Omit<VideoRecord, 'lastSeenAt'> {
  return {
    id: item.videoId,
    channelId,
    platform: item.platform,
    url: item.url,
    caption: item.caption,
    publishedAt: item.publishedAt,
    publishedMonth: item.publishedMonth,
    views: item.views,
    likes: item.likes,
    comments: item.comments,
    shares: item.shares,
    durationSec: item.durationSec,
    thumbnailUrl: item.thumbnailUrl,
  };
}

export async function fetchApifyAccountLimits(token: string): Promise<ApifyAccountLimits> {
  const checkedAt = new Date().toISOString();
  try {
    const [meRes, limitsRes] = await Promise.all([
      fetch(`${APIFY_BASE}/users/me?token=${encodeURIComponent(token)}`),
      fetch(`${APIFY_BASE}/users/me/limits?token=${encodeURIComponent(token)}`),
    ]);

    if (!meRes.ok) {
      return {
        username: null,
        monthlyUsageUsd: null,
        maxMonthlyUsageUsd: null,
        remainingUsd: null,
        planName: null,
        checkedAt,
        error: `Apify auth failed (HTTP ${meRes.status})`,
      };
    }

    const meJson = (await meRes.json()) as { data?: Record<string, unknown> };
    const limitsJson = limitsRes.ok
      ? ((await limitsRes.json()) as { data?: Record<string, unknown> })
      : { data: {} };

    const meData = meJson.data ?? {};
    const limitsData = limitsJson.data ?? {};
    const current = (limitsData.current ?? {}) as Record<string, unknown>;
    const limits = (limitsData.limits ?? {}) as Record<string, unknown>;
    const plan = (meData.plan ?? {}) as Record<string, unknown>;

    const monthlyUsageUsd =
      typeof current.monthlyUsageUsd === 'number' ? Number(current.monthlyUsageUsd.toFixed(4)) : null;
    const maxMonthlyUsageUsd =
      typeof limits.maxMonthlyUsageUsd === 'number' ? Number(limits.maxMonthlyUsageUsd.toFixed(4)) : null;
    const remainingUsd =
      monthlyUsageUsd !== null && maxMonthlyUsageUsd !== null
        ? Number(Math.max(0, maxMonthlyUsageUsd - monthlyUsageUsd).toFixed(4))
        : null;

    return {
      username: asString(meData.username) || null,
      monthlyUsageUsd,
      maxMonthlyUsageUsd,
      remainingUsd,
      planName: asString(plan.id || plan.name) || null,
      checkedAt,
    };
  } catch (err) {
    return {
      username: null,
      monthlyUsageUsd: null,
      maxMonthlyUsageUsd: null,
      remainingUsd: null,
      planName: null,
      checkedAt,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function startApifyActorBatch(options: {
  token: string;
  actorId: string;
  input: Record<string, unknown>;
  maxTotalChargeUsd: number;
  timeoutSecs?: number;
}): Promise<ApifyRunStartResult> {
  const { token, actorId, input, maxTotalChargeUsd } = options;
  const timeoutSecs = options.timeoutSecs ?? 300;

  const startUrl = new URL(`${APIFY_BASE}/acts/${actorIdToPath(actorId)}/runs`);
  startUrl.searchParams.set('token', token);
  startUrl.searchParams.set('timeout', String(timeoutSecs));
  startUrl.searchParams.set('maxTotalChargeUsd', String(Number(maxTotalChargeUsd.toFixed(3))));

  const startRes = await fetch(startUrl.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });

  if (!startRes.ok) {
    const errText = await startRes.text().catch(() => '');
    throw new Error(`Không thể khởi chạy Actor "${actorId}" (HTTP ${startRes.status}): ${errText.slice(0, 300)}`);
  }

  const startJson = (await startRes.json()) as { data?: Record<string, unknown> };
  const runData = startJson.data ?? {};
  const apifyRunId = asString(runData.id);
  const status = asString(runData.status) || 'RUNNING';
  const datasetId = asString(runData.defaultDatasetId);

  if (!apifyRunId) {
    throw new Error(`Apify không trả về runId cho Actor "${actorId}"`);
  }

  return { actorId, apifyRunId, datasetId, status };
}

export async function getApifyRunStatus(token: string, apifyRunId: string): Promise<ApifyRunPollResult> {
  const pollRes = await fetch(
    `${APIFY_BASE}/actor-runs/${encodeURIComponent(apifyRunId)}?token=${encodeURIComponent(token)}`,
  );
  if (!pollRes.ok) {
    throw new Error(`Không kiểm tra được trạng thái run ${apifyRunId} (HTTP ${pollRes.status})`);
  }
  const pollJson = (await pollRes.json()) as { data?: Record<string, unknown> };
  const latest = pollJson.data ?? {};
  return {
    apifyRunId,
    datasetId: asString(latest.defaultDatasetId),
    status: asString(latest.status) || 'RUNNING',
    usageTotalUsd: typeof latest.usageTotalUsd === 'number' ? Number(latest.usageTotalUsd.toFixed(4)) : 0,
  };
}

export async function fetchApifyDatasetItems(token: string, datasetId: string): Promise<Record<string, unknown>[]> {
  if (!datasetId) return [];
  const itemsRes = await fetch(
    `${APIFY_BASE}/datasets/${encodeURIComponent(datasetId)}/items?clean=true&format=json&token=${encodeURIComponent(token)}`,
  );
  if (!itemsRes.ok) return [];
  const parsed = (await itemsRes.json()) as unknown;
  return Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : [];
}

export async function runApifyActorBatch(options: {
  token: string;
  actorId: string;
  input: Record<string, unknown>;
  maxTotalChargeUsd: number;
  timeoutSecs?: number;
  pollIntervalMs?: number;
}): Promise<ApifyRunResult> {
  const timeoutSecs = options.timeoutSecs ?? 300;
  const pollIntervalMs = options.pollIntervalMs ?? 3000;
  const started = await startApifyActorBatch(options);

  let status = started.status;
  let datasetId = started.datasetId;
  let usageTotalUsd = 0;

  const deadline = Date.now() + (timeoutSecs + 30) * 1000;
  while (['READY', 'RUNNING'].includes(status) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    try {
      const latest = await getApifyRunStatus(options.token, started.apifyRunId);
      status = latest.status;
      datasetId = latest.datasetId || datasetId;
      usageTotalUsd = latest.usageTotalUsd;
    } catch {
      // retry next interval
    }
  }

  const items = await fetchApifyDatasetItems(options.token, datasetId);

  return {
    actorId: started.actorId,
    apifyRunId: started.apifyRunId,
    datasetId,
    status,
    usageTotalUsd,
    items,
  };
}
