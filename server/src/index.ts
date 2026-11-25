import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  buildFacebookActorInput,
  buildTiktokActorInput,
  estimateCostUsd,
  extractTiktokError,
  extractTiktokProfileNote,
  fetchApifyAccountLimits,
  fetchApifyDatasetItems,
  getApifyRunStatus,
  mapNormalizedToVideoRecord,
  matchItemToChannel,
  normalizeFacebookItem,
  normalizeTiktokItem,
  runApifyActorBatch,
  startApifyActorBatch,
} from './apify.js';
import { TrackerDb } from './db.js';
import {
  buildChannelsCsv,
  buildDoctorsCsv,
  buildMonthlyExportSheetRows,
  extractGoogleSheetInfo,
  getCurrentMonth,
  getMonthStartDate,
  parseBulkChannelText,
  parseChannelLine,
  parseGoogleSheetRows,
} from './parser.js';
import type { Channel, DashboardPayload, Platform } from './types.js';

const APP_URI = 'ui://social-video-tracker/app.html';
const APP_MIME = 'text/html;profile=mcp-app';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');

function parseArgs(argv: string[]): { dataDir: string } {
  let dataDir = path.join(PLUGIN_ROOT, 'data');
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--data-dir=')) {
      dataDir = arg.slice('--data-dir='.length);
    } else if (arg === '--data-dir' && argv[i + 1]) {
      dataDir = argv[i + 1];
      i++;
    }
  }
  return { dataDir };
}

function readAppHtml(): string {
  const htmlPath = process.env.SOCIAL_TRACKER_APP_HTML || path.join(PLUGIN_ROOT, 'ui', 'dist', 'index.html');
  if (!fs.existsSync(htmlPath)) {
    return `<!doctype html><html><body style="font-family:system-ui;padding:24px"><h2>Social Video Tracker UI not built</h2><p>Missing file: <code>${htmlPath}</code>. Run <code>bun run build</code> inside the plugin directory.</p></body></html>`;
  }
  return fs.readFileSync(htmlPath, 'utf8');
}

function formatNumber(n: number): string {
  return new Intl.NumberFormat('en-US').format(n);
}

function summarizeDashboardText(dash: DashboardPayload): string {
  const s = dash.summary;
  const creditText =
    dash.apifyLimits?.remainingUsd !== null && dash.apifyLimits?.remainingUsd !== undefined
      ? `Apify credit remaining: $${dash.apifyLimits.remainingUsd.toFixed(2)} / $${(dash.apifyLimits.maxMonthlyUsageUsd ?? s.monthlyBudgetUsd).toFixed(2)}`
      : `Tracked local spend (${dash.month}): $${s.monthSpendUsd.toFixed(2)} / $${s.monthlyBudgetUsd.toFixed(2)}`;

  return [
    `Social Video Tracker — Month ${dash.month} (since ${dash.sinceDate})`,
    `- Channels: ${s.totalChannels} (${s.tiktokChannels} TikTok, ${s.facebookChannels} Facebook; enabled: ${s.enabledChannels})`,
    `- Videos in ${dash.month}: ${formatNumber(s.periodVideos)} (TikTok: ${formatNumber(s.tiktokPeriodVideos)}, Facebook: ${formatNumber(s.facebookPeriodVideos)})`,
    `- Views in ${dash.month}: ${formatNumber(s.periodViews)} (Avg: ${formatNumber(s.avgViewsPerVideo)} views/video)`,
    `- Engagement in ${dash.month}: ${formatNumber(s.periodLikes)} likes · ${formatNumber(s.periodComments)} comments · ${formatNumber(s.periodShares)} shares`,
    `- ${creditText}`,
    `- Apify Token: ${dash.settings.hasApifyToken ? 'Configured' : 'Not configured (open Scan & Settings tab)'}`,
  ].join('\n');
}

export function createTrackerServer(dataDir: string) {
  const db = new TrackerDb(dataDir);

  const server = new McpServer(
    { name: 'social-video-tracker', version: '1.0.0' },
    { capabilities: { resources: {}, tools: {} } },
  );

  server.registerResource(
    'Social Video Tracker App',
    APP_URI,
    {
      description: 'Interactive TikTok & Facebook monthly video, view, like, and comment tracker dashboard',
      mimeType: APP_MIME,
      _meta: { ui: { prefersBorder: false } },
    },
    async () => ({
      contents: [
        {
          uri: APP_URI,
          mimeType: APP_MIME,
          text: readAppHtml(),
          _meta: { ui: { prefersBorder: false } },
        },
      ],
    }),
  );

  function ingestDatasetItems(
    batchPlatform: Platform,
    batchChannels: Channel[],
    items: Record<string, unknown>[],
    sinceDate: string,
  ) {
    const matchedVideos: ReturnType<typeof mapNormalizedToVideoRecord>[] = [];
    const profileUpdates = new Map<number, { videoCount: number | null; followers: number | null }>();
    const channelErrors = new Map<number, string>();

    for (const rawItem of items) {
      if (batchPlatform === 'tiktok') {
        const errInfo = extractTiktokError(rawItem);
        if (errInfo) {
          const matchedErrChannel = batchChannels.find((c) =>
            errInfo.channelMatchKeys.includes(c.handle.toLowerCase()),
          );
          if (matchedErrChannel && errInfo.errorCode !== 'NO_VIDEOS') {
            channelErrors.set(matchedErrChannel.id, `${errInfo.errorCode}: ${errInfo.errorMessage}`.slice(0, 180));
          }
          continue;
        }

        const profileNote = extractTiktokProfileNote(rawItem);
        if (profileNote) {
          const matchedNoteChannel = batchChannels.find((c) => c.handle.toLowerCase() === profileNote.handle);
          if (matchedNoteChannel) {
            profileUpdates.set(matchedNoteChannel.id, {
              videoCount: profileNote.profileVideoCount,
              followers: profileNote.profileFollowers,
            });
            if (/login wall/i.test(profileNote.note)) {
              channelErrors.set(matchedNoteChannel.id, `LOGIN_WALL: ${profileNote.note}`.slice(0, 180));
            }
          }
          continue;
        }
      }

      const normalized =
        batchPlatform === 'tiktok' ? normalizeTiktokItem(rawItem) : normalizeFacebookItem(rawItem);
      if (!normalized) continue;

      const matchedChannel = matchItemToChannel(normalized, batchChannels);
      if (!matchedChannel) continue;

      if (normalized.profileVideoCount !== null || normalized.profileFollowers !== null) {
        profileUpdates.set(matchedChannel.id, {
          videoCount: normalized.profileVideoCount,
          followers: normalized.profileFollowers,
        });
      }

      matchedVideos.push(mapNormalizedToVideoRecord(normalized, matchedChannel.id));
    }

    if (matchedVideos.length > 0) db.upsertVideos(matchedVideos);

    const finishedAt = new Date().toISOString();
    for (const ch of batchChannels) {
      const prof = profileUpdates.get(ch.id);
      db.updateChannelScanMeta(ch.id, {
        profileVideoCount: prof?.videoCount ?? null,
        profileFollowers: prof?.followers ?? null,
        lastScannedAt: finishedAt,
        lastError: channelErrors.get(ch.id) ?? null,
      });
    }

    const inPeriodCount = matchedVideos.filter(
      (v) => v.publishedAt && v.publishedAt.slice(0, 10) >= sinceDate,
    ).length;

    return { videosFetched: matchedVideos.length, videosInPeriod: inPeriodCount, finishedAt };
  }

  function prepareScanPlan(params: {
    month?: string;
    sinceDate?: string;
    platform?: 'all' | 'tiktok' | 'facebook';
    channelIds?: number[];
    maxVideosTiktok?: number;
    maxVideosFacebook?: number;
    maxBudgetUsd?: number;
  }) {
    const settings = db.getSettings();
    const targetMonth =
      params.month && /^\d{4}-\d{2}$/.test(params.month)
        ? params.month
        : params.sinceDate && /^\d{4}-\d{2}-\d{2}$/.test(params.sinceDate)
          ? params.sinceDate.slice(0, 7)
          : getCurrentMonth();
    const sinceDate =
      params.sinceDate && /^\d{4}-\d{2}-\d{2}$/.test(params.sinceDate)
        ? params.sinceDate
        : getMonthStartDate(targetMonth);

    const platform = params.platform ?? 'all';
    const maxTiktok = params.maxVideosTiktok ?? settings.defaultMaxVideosTiktok;
    const maxFb = params.maxVideosFacebook ?? settings.defaultMaxVideosFacebook;
    const requestedBudget = params.maxBudgetUsd ?? settings.perRunBudgetUsd;

    const selectedChannels = db.listChannels({
      platform,
      enabledOnly: !params.channelIds || params.channelIds.length === 0,
      ids: params.channelIds,
    });
    const tiktokChannels = selectedChannels.filter((c) => c.platform === 'tiktok');
    const fbChannels = selectedChannels.filter((c) => c.platform === 'facebook');

    const estimate = estimateCostUsd(tiktokChannels.length, fbChannels.length, maxTiktok, maxFb);
    const localMonthSpend = db.getMonthLocalSpendUsd(targetMonth);
    const remainingBudget = Math.max(0, Number((settings.monthlyBudgetUsd - localMonthSpend).toFixed(4)));
    const effectiveBudget = Math.min(requestedBudget, Math.max(remainingBudget, 0));

    let tiktokBudget = effectiveBudget;
    let fbBudget = effectiveBudget;
    if (tiktokChannels.length > 0 && fbChannels.length > 0) {
      const tiktokWeight = Math.max(0.15, tiktokChannels.length * maxTiktok * 3.0);
      const fbWeight = Math.max(0.05, fbChannels.length * maxFb * 0.9);
      const ratio = tiktokWeight / (tiktokWeight + fbWeight);
      tiktokBudget = Number(Math.max(0.1, effectiveBudget * ratio).toFixed(3));
      fbBudget = Number(Math.max(0.1, effectiveBudget - tiktokBudget).toFixed(3));
    }

    return {
      settings,
      targetMonth,
      sinceDate,
      platform,
      maxTiktok,
      maxFb,
      selectedChannels,
      tiktokChannels,
      fbChannels,
      estimate,
      localMonthSpend,
      remainingBudget,
      effectiveBudget,
      tiktokBudget,
      fbBudget,
    };
  }

  async function startAsyncScan(params: {
    month?: string;
    sinceDate?: string;
    platform?: 'all' | 'tiktok' | 'facebook';
    channelIds?: number[];
    maxVideosTiktok?: number;
    maxVideosFacebook?: number;
    maxBudgetUsd?: number;
  }) {
    const plan = prepareScanPlan(params);
    if (plan.selectedChannels.length === 0) {
      return {
        ok: false,
        message: 'No enabled channels found. Add channels manually or sync from a Google Sheet first.',
        dashboard: db.getDashboard({ month: plan.targetMonth }),
      };
    }

    const token = db.getRawApifyToken();
    if (!token) {
      return {
        ok: false,
        message: 'Apify API Token is not configured. Open the Scan & Settings tab to add your Apify token.',
        dashboard: db.getDashboard({ month: plan.targetMonth }),
      };
    }

    if (plan.effectiveBudget <= 0.01) {
      return {
        ok: false,
        message: `Monthly budget cap reached ($${plan.localMonthSpend.toFixed(2)} / $${plan.settings.monthlyBudgetUsd.toFixed(2)}).`,
        dashboard: db.getDashboard({ month: plan.targetMonth }),
      };
    }

    const startedRuns: ReturnType<typeof db.recordScanRun>[] = [];
    const errors: string[] = [];

    const launchBatch = async (batchPlatform: Platform, batchChannels: Channel[], actorId: string, budgetUsd: number) => {
      const startedAt = new Date().toISOString();
      try {
        const input =
          batchPlatform === 'tiktok'
            ? buildTiktokActorInput(batchChannels, plan.sinceDate, plan.maxTiktok)
            : buildFacebookActorInput(batchChannels, plan.maxFb);

        const started = await startApifyActorBatch({
          token,
          actorId,
          input,
          maxTotalChargeUsd: budgetUsd,
        });

        const rec = db.recordScanRun({
          platform: batchPlatform,
          actorId,
          apifyRunId: started.apifyRunId,
          sinceDate: plan.sinceDate,
          channelsCount: batchChannels.length,
          channelIds: batchChannels.map((c) => c.id),
          videosFetched: 0,
          videosInPeriod: 0,
          costUsd: 0,
          status: 'running',
          errorMessage: null,
          startedAt,
          finishedAt: null,
        });
        startedRuns.push(rec);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${batchPlatform.toUpperCase()}: ${msg}`);
        db.recordScanRun({
          platform: batchPlatform,
          actorId,
          apifyRunId: null,
          sinceDate: plan.sinceDate,
          channelsCount: batchChannels.length,
          channelIds: batchChannels.map((c) => c.id),
          videosFetched: 0,
          videosInPeriod: 0,
          costUsd: 0,
          status: 'failed',
          errorMessage: msg.slice(0, 300),
          startedAt,
          finishedAt: new Date().toISOString(),
        });
      }
    };

    const jobs: Promise<void>[] = [];
    if (plan.tiktokChannels.length > 0) {
      jobs.push(launchBatch('tiktok', plan.tiktokChannels, plan.settings.tiktokActorId, plan.tiktokBudget));
    }
    if (plan.fbChannels.length > 0) {
      jobs.push(launchBatch('facebook', plan.fbChannels, plan.settings.facebookActorId, plan.fbBudget));
    }
    await Promise.all(jobs);

    return {
      ok: startedRuns.length > 0,
      startedRuns,
      errors,
      message:
        startedRuns.length > 0
          ? `Started ${startedRuns.length} parallel Apify scan job(s) since ${plan.sinceDate}. Polling live progress...`
          : `Failed to start scan: ${errors.join('; ')}`,
      dashboard: db.getDashboard({ month: plan.targetMonth }),
    };
  }

  async function pollActiveScans(month?: string) {
    const running = db.listRunningRuns();
    const targetMonth = month && /^\d{4}-\d{2}$/.test(month) ? month : getCurrentMonth();
    const token = db.getRawApifyToken();

    if (running.length === 0 || !token) {
      return {
        stillRunningCount: 0,
        completedNotes: [] as string[],
        progressLines: [] as string[],
        dashboard: db.getDashboard({ month: targetMonth }),
      };
    }

    const completedNotes: string[] = [];
    const progressLines: string[] = [];
    let anyCompleted = false;

    await Promise.all(
      running.map(async (run) => {
        if (!run.apifyRunId) return;
        try {
          const poll = await getApifyRunStatus(token, run.apifyRunId);
          const elapsedSec = Math.max(1, Math.round((Date.now() - new Date(run.startedAt).getTime()) / 1000));

          if (['READY', 'RUNNING'].includes(poll.status)) {
            db.updateScanRun(run.id, { costUsd: poll.usageTotalUsd });
            progressLines.push(
              `${run.platform.toUpperCase()} (${run.channelsCount} ch): ${poll.status} · ${elapsedSec}s · $${poll.usageTotalUsd.toFixed(3)}`,
            );
            return;
          }

          anyCompleted = true;
          const batchPlatform = run.platform === 'facebook' ? 'facebook' : 'tiktok';
          const batchChannels =
            run.channelIds && run.channelIds.length > 0
              ? db.listChannels({ ids: run.channelIds })
              : db.listChannels({ platform: batchPlatform, enabledOnly: true });

          const items = await fetchApifyDatasetItems(token, poll.datasetId);
          const stats = ingestDatasetItems(batchPlatform, batchChannels, items, run.sinceDate);
          const finalStatus =
            poll.status === 'SUCCEEDED' ? 'succeeded' : stats.videosFetched > 0 ? 'partial' : 'failed';

          db.updateScanRun(run.id, {
            videosFetched: stats.videosFetched,
            videosInPeriod: stats.videosInPeriod,
            costUsd: poll.usageTotalUsd,
            status: finalStatus,
            errorMessage: finalStatus === 'succeeded' ? null : `Apify status: ${poll.status}`,
            finishedAt: stats.finishedAt,
          });

          completedNotes.push(
            `${batchPlatform.toUpperCase()} (${batchChannels.length} ch): fetched ${stats.videosFetched} videos (${stats.videosInPeriod} since ${run.sinceDate}), cost $${poll.usageTotalUsd.toFixed(4)} (${poll.status})`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          progressLines.push(`${run.platform.toUpperCase()}: reconnecting (${msg.slice(0, 80)})`);
        }
      }),
    );

    const remainingRunning = db.listRunningRuns();
    if (anyCompleted && remainingRunning.length === 0) {
      const freshLimits = await fetchApifyAccountLimits(token);
      if (!freshLimits.error) db.saveCachedApifyLimits(freshLimits);
    }

    return {
      stillRunningCount: remainingRunning.length,
      completedNotes,
      progressLines,
      dashboard: db.getDashboard({ month: targetMonth }),
    };
  }

  async function executeScan(params: {
    month?: string;
    sinceDate?: string;
    platform?: 'all' | 'tiktok' | 'facebook';
    channelIds?: number[];
    maxVideosTiktok?: number;
    maxVideosFacebook?: number;
    maxBudgetUsd?: number;
    dryRun?: boolean;
  }) {
    const plan = prepareScanPlan(params);
    if (plan.selectedChannels.length === 0) {
      return {
        ok: false,
        message: 'No enabled channels found. Add channels or sync from a Google Sheet first.',
        dashboard: db.getDashboard({ month: plan.targetMonth }),
      };
    }

    if (params.dryRun) {
      const run = db.recordScanRun({
        platform: plan.platform,
        actorId: [
          plan.tiktokChannels.length > 0 ? plan.settings.tiktokActorId : '',
          plan.fbChannels.length > 0 ? plan.settings.facebookActorId : '',
        ]
          .filter(Boolean)
          .join(' + '),
        apifyRunId: null,
        sinceDate: plan.sinceDate,
        channelsCount: plan.selectedChannels.length,
        channelIds: plan.selectedChannels.map((c) => c.id),
        videosFetched: 0,
        videosInPeriod: 0,
        costUsd: 0,
        status: 'dry_run',
        errorMessage: null,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      });

      return {
        ok: true,
        dryRun: true,
        sinceDate: plan.sinceDate,
        month: plan.targetMonth,
        estimate: plan.estimate,
        effectiveBudgetUsd: plan.effectiveBudget,
        remainingMonthlyBudgetUsd: plan.remainingBudget,
        run,
        message: [
          `[DRY RUN] Estimate since ${plan.sinceDate} (${plan.tiktokChannels.length} TikTok + ${plan.fbChannels.length} Facebook):`,
          `- Per-channel cap: ${plan.maxTiktok} TikTok videos, ${plan.maxFb} Facebook reels`,
          `- Estimated cost: ~$${plan.estimate.estimatedUsd.toFixed(2)} (worst-case: ~$${plan.estimate.worstCaseUsd.toFixed(2)})`,
          `- Apify maxTotalChargeUsd cap: $${plan.effectiveBudget.toFixed(2)} (remaining monthly cap: $${plan.remainingBudget.toFixed(2)} / $${plan.settings.monthlyBudgetUsd.toFixed(2)})`,
          `- $0 spent in Dry Run mode.`,
        ].join('\n'),
        dashboard: db.getDashboard({ month: plan.targetMonth }),
      };
    }

    const token = db.getRawApifyToken();
    if (!token) {
      return {
        ok: false,
        message: 'Apify API Token is not configured. Add it in Scan & Settings first.',
        dashboard: db.getDashboard({ month: plan.targetMonth }),
      };
    }

    if (plan.effectiveBudget <= 0.01) {
      return {
        ok: false,
        message: `Monthly budget cap reached ($${plan.localMonthSpend.toFixed(2)} / $${plan.settings.monthlyBudgetUsd.toFixed(2)}).`,
        dashboard: db.getDashboard({ month: plan.targetMonth }),
      };
    }

    const notes: string[] = [];
    let totalFetched = 0;
    let totalInPeriod = 0;
    let totalCostUsd = 0;

    const runPlatformBatch = async (batchPlatform: Platform, batchChannels: Channel[], actorId: string, budgetUsd: number) => {
      const startedAt = new Date().toISOString();
      try {
        const input =
          batchPlatform === 'tiktok'
            ? buildTiktokActorInput(batchChannels, plan.sinceDate, plan.maxTiktok)
            : buildFacebookActorInput(batchChannels, plan.maxFb);

        const res = await runApifyActorBatch({ token, actorId, input, maxTotalChargeUsd: budgetUsd });
        const stats = ingestDatasetItems(batchPlatform, batchChannels, res.items, plan.sinceDate);
        totalFetched += stats.videosFetched;
        totalInPeriod += stats.videosInPeriod;
        totalCostUsd += res.usageTotalUsd;

        db.recordScanRun({
          platform: batchPlatform,
          actorId,
          apifyRunId: res.apifyRunId,
          sinceDate: plan.sinceDate,
          channelsCount: batchChannels.length,
          channelIds: batchChannels.map((c) => c.id),
          videosFetched: stats.videosFetched,
          videosInPeriod: stats.videosInPeriod,
          costUsd: res.usageTotalUsd,
          status: res.status === 'SUCCEEDED' ? 'succeeded' : 'partial',
          errorMessage: res.status === 'SUCCEEDED' ? null : `Apify status: ${res.status}`,
          startedAt,
          finishedAt: stats.finishedAt,
        });

        notes.push(
          `${batchPlatform.toUpperCase()} (${batchChannels.length} ch, ${actorId}): fetched ${stats.videosFetched} videos (${stats.videosInPeriod} since ${plan.sinceDate}), cost $${res.usageTotalUsd.toFixed(4)} (${res.status}).`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const finishedAt = new Date().toISOString();
        for (const ch of batchChannels) {
          db.updateChannelScanMeta(ch.id, { lastScannedAt: finishedAt, lastError: msg.slice(0, 200) });
        }
        db.recordScanRun({
          platform: batchPlatform,
          actorId,
          apifyRunId: null,
          sinceDate: plan.sinceDate,
          channelsCount: batchChannels.length,
          channelIds: batchChannels.map((c) => c.id),
          videosFetched: 0,
          videosInPeriod: 0,
          costUsd: 0,
          status: 'failed',
          errorMessage: msg.slice(0, 300),
          startedAt,
          finishedAt,
        });
        notes.push(`${batchPlatform.toUpperCase()} error: ${msg}`);
      }
    };

    const parallelBatches: Promise<void>[] = [];
    if (plan.tiktokChannels.length > 0) {
      parallelBatches.push(runPlatformBatch('tiktok', plan.tiktokChannels, plan.settings.tiktokActorId, plan.tiktokBudget));
    }
    if (plan.fbChannels.length > 0) {
      parallelBatches.push(runPlatformBatch('facebook', plan.fbChannels, plan.settings.facebookActorId, plan.fbBudget));
    }
    await Promise.all(parallelBatches);

    const freshLimits = await fetchApifyAccountLimits(token);
    if (!freshLimits.error) db.saveCachedApifyLimits(freshLimits);

    const dashboard = db.getDashboard({ month: plan.targetMonth });
    return {
      ok: true,
      dryRun: false,
      sinceDate: plan.sinceDate,
      month: plan.targetMonth,
      totalFetched,
      totalInPeriod,
      totalCostUsd: Number(totalCostUsd.toFixed(4)),
      apifyLimits: freshLimits,
      notes,
      message: [
        `Scan completed (since ${plan.sinceDate}):`,
        ...notes.map((n) => `- ${n}`),
        freshLimits.remainingUsd !== null
          ? `- Remaining Apify credit: $${freshLimits.remainingUsd.toFixed(2)} / $${(freshLimits.maxMonthlyUsageUsd ?? 5).toFixed(2)}`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
      dashboard,
    };
  }

  // === MODEL + APP TOOLS ===

  server.registerTool(
    'open_social_tracker',
    {
      title: 'Social Tracker',
      description:
        'Open the interactive Social Video Tracker dashboard to manage TikTok & Facebook channels, run monthly Apify scans within a $5/month Free-tier budget, and export CSV or Google Sheets reports.',
      inputSchema: {
        month: z.string().regex(/^\d{4}-\d{2}$/).optional().describe('Target month YYYY-MM (defaults to current month)'),
        platform: z.enum(['all', 'tiktok', 'facebook']).optional(),
        search: z.string().optional(),
      },
      _meta: {
        ui: { resourceUri: APP_URI },
        'com.google.antigravity/ui': {
          entrypoints: [
            { type: 'aux_pane', title: 'Social Tracker' },
            { type: 'global', title: 'Social Tracker' },
          ],
        },
      },
    },
    async (args) => {
      const dashboard = db.getDashboard({ month: args?.month, platform: args?.platform, search: args?.search });
      return {
        content: [{ type: 'text', text: summarizeDashboardText(dashboard) }],
        structuredContent: dashboard as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    'get_monthly_report',
    {
      title: 'Get Monthly Social Report',
      description:
        'Read monthly TikTok & Facebook video counts, views, likes, and comments from local SQLite cache ($0 Apify cost).',
      inputSchema: {
        month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
        platform: z.enum(['all', 'tiktok', 'facebook']).optional(),
        groupByCreator: z.boolean().optional().describe('Group paired TikTok + Facebook channels by creator/group'),
      },
    },
    async (args) => {
      const dashboard = db.getDashboard({ month: args?.month, platform: args?.platform });
      const lines: string[] = [summarizeDashboardText(dashboard), ''];
      if (args?.groupByCreator) {
        lines.push('Top creator groups by views:');
        for (const d of dashboard.doctors.slice(0, 15)) {
          lines.push(
            `- ${d.doctorGroup}: ${d.totalVideos} videos | ${formatNumber(d.totalViews)} views | ${formatNumber(d.totalLikes)} likes | ${formatNumber(d.totalComments)} comments`,
          );
        }
      } else {
        lines.push('Top channels by views:');
        for (const r of dashboard.channels.slice(0, 15)) {
          lines.push(
            `- [${r.channel.platform}] ${r.channel.displayName} (@${r.channel.handle}): ${r.periodVideos} videos | ${formatNumber(r.periodViews)} views | ${formatNumber(r.periodLikes)} likes | ${formatNumber(r.periodComments)} comments`,
          );
        }
      }
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: {
          month: dashboard.month,
          sinceDate: dashboard.sinceDate,
          summary: dashboard.summary,
          groups: dashboard.doctors,
          channels: dashboard.channels,
        },
      };
    },
  );

  server.registerTool(
    'scan_channels',
    {
      title: 'Scan TikTok & Facebook Channels',
      description:
        'Run a batched Apify scan for enabled TikTok and/or Facebook channels from the start of the month (YYYY-MM-01) with a hard maxTotalChargeUsd budget cap. Set dryRun=true to estimate cost without spending.',
      inputSchema: {
        sinceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        platform: z.enum(['all', 'tiktok', 'facebook']).optional(),
        channelIds: z.array(z.number().int().positive()).optional(),
        maxVideosTiktok: z.number().int().min(1).max(100).optional(),
        maxVideosFacebook: z.number().int().min(1).max(100).optional(),
        maxBudgetUsd: z.number().min(0.05).max(50).optional(),
        dryRun: z.boolean().optional(),
      },
    },
    async (args) => {
      const result = await executeScan(args ?? {});
      return {
        content: [{ type: 'text', text: result.message }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    'sync_channels_from_sheet',
    {
      title: 'Sync Channels From Google Sheet Rows',
      description:
        'Import or update TikTok & Facebook channels from 2D rows read from any Google Sheet (auto-detects columns from headers and scans all cells for TikTok/Facebook URLs).',
      inputSchema: {
        rows: z.array(z.array(z.unknown())).describe('2D array of rows from Google Sheets'),
        sheetUrl: z.string().optional(),
        sheetTab: z.string().optional(),
        replaceExisting: z.boolean().optional().describe('Disable existing channels not found in this sheet'),
      },
    },
    async (args) => {
      if (args.sheetUrl !== undefined || args.sheetTab !== undefined) {
        db.saveSettings({ googleSheetUrl: args.sheetUrl, googleSheetTab: args.sheetTab });
      }
      const parsed = parseGoogleSheetRows(args.rows);
      const syncedKeys = new Set<string>();
      for (const item of parsed) {
        db.upsertChannel(item);
        syncedKeys.add(`${item.platform}:${item.handle.toLowerCase()}`);
      }

      let disabledMissing = 0;
      if (args.replaceExisting && parsed.length > 0) {
        for (const existing of db.listChannels({ enabledOnly: true })) {
          const key = `${existing.platform}:${existing.handle.toLowerCase()}`;
          if (!syncedKeys.has(key)) {
            db.upsertChannel({
              id: existing.id,
              platform: existing.platform,
              handle: existing.handle,
              url: existing.url,
              displayName: existing.displayName,
              doctorGroup: existing.doctorGroup,
              enabled: false,
            });
            disabledMissing++;
          }
        }
      }

      const activeCount = parsed.filter((p) => p.enabled).length;
      const stoppedCount = parsed.length - activeCount;
      const dashboard = db.getDashboard();
      return {
        content: [
          {
            type: 'text',
            text: `Synced ${parsed.length} channels from Google Sheet (${activeCount} enabled, ${stoppedCount} inactive${disabledMissing > 0 ? `, disabled ${disabledMissing} channels removed from sheet` : ''}). Total tracked: ${dashboard.summary.totalChannels}.`,
          },
        ],
        structuredContent: { syncedCount: parsed.length, activeCount, stoppedCount, disabledMissing, dashboard },
      };
    },
  );

  server.registerTool(
    'prepare_sheet_export',
    {
      title: 'Prepare Monthly Google Sheet Export',
      description:
        'Generate a gsheets batch JSON file to export a month (YYYY-MM) as its own tab in Google Sheets, and optionally save exportSheetUrl in settings.',
      inputSchema: {
        month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
        exportSheetUrl: z.string().optional(),
      },
    },
    async (args) => {
      if (args?.exportSheetUrl?.trim()) {
        db.saveSettings({ exportSheetUrl: args.exportSheetUrl.trim() });
      }
      const dash = db.getDashboard({ month: args?.month });
      const rows = buildMonthlyExportSheetRows(dash);
      const exportSheetUrl = dash.settings.exportSheetUrl;
      const sheetInfo = exportSheetUrl ? extractGoogleSheetInfo(exportSheetUrl) : null;

      const exportsDir = path.join(dataDir, 'exports');
      fs.mkdirSync(exportsDir, { recursive: true });
      const batchFilePath = path.join(exportsDir, `gsheet-batch-${dash.month}.json`);
      fs.writeFileSync(
        batchFilePath,
        JSON.stringify([{ op: 'write', range: `'${dash.month}'!A1`, data: rows }], null, 2),
        'utf8',
      );

      return {
        content: [
          {
            type: 'text',
            text: [
              `Prepared monthly export for tab "${dash.month}" (${rows.length} rows) at: ${batchFilePath}`,
              exportSheetUrl
                ? `Configured export spreadsheet: ${exportSheetUrl} (ID: ${sheetInfo?.spreadsheetId ?? 'unknown'})`
                : 'No export spreadsheet configured yet — create a new spreadsheet and save its URL with prepare_sheet_export(exportSheetUrl).',
            ].join('\n'),
          },
        ],
        structuredContent: {
          month: dash.month,
          tabTitle: dash.month,
          rowCount: rows.length,
          batchFilePath,
          exportSheetUrl,
          exportSpreadsheetId: sheetInfo?.spreadsheetId ?? null,
        },
      };
    },
  );

  // === APP-ONLY TOOLS ===

  server.registerTool(
    'app_start_scan',
    {
      description: 'Start batched Apify scans asynchronously to avoid RPC timeouts',
      inputSchema: {
        sinceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        platform: z.enum(['all', 'tiktok', 'facebook']).optional(),
        channelIds: z.array(z.number().int().positive()).optional(),
        maxVideosTiktok: z.number().int().min(1).max(100).optional(),
        maxVideosFacebook: z.number().int().min(1).max(100).optional(),
        maxBudgetUsd: z.number().min(0.05).max(50).optional(),
      },
      _meta: { ui: { visibility: ['app'] } },
    },
    async (args) => {
      const result = await startAsyncScan(args ?? {});
      return {
        isError: !result.ok,
        content: [{ type: 'text', text: result.message }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    'app_poll_scan',
    {
      description: 'Poll active Apify scan jobs and ingest completed datasets',
      inputSchema: { month: z.string().optional() },
      _meta: { ui: { visibility: ['app'] } },
    },
    async (args) => {
      const result = await pollActiveScans(args?.month);
      return {
        content: [{ type: 'text', text: result.stillRunningCount > 0 ? 'running' : 'done' }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    'app_get_dashboard',
    {
      description: 'Fetch dashboard data for the UI',
      inputSchema: {
        month: z.string().optional(),
        platform: z.enum(['all', 'tiktok', 'facebook']).optional(),
        search: z.string().optional(),
      },
      _meta: { ui: { visibility: ['app'] } },
    },
    async (args) => ({
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: db.getDashboard({
        month: args?.month,
        platform: args?.platform,
        search: args?.search,
      }) as unknown as Record<string, unknown>,
    }),
  );

  server.registerTool(
    'app_get_videos',
    {
      description: 'List tracked videos for a month or specific channel',
      inputSchema: {
        month: z.string().optional(),
        channelId: z.number().int().positive().optional(),
        platform: z.enum(['all', 'tiktok', 'facebook']).optional(),
        sortBy: z.enum(['views', 'published_at']).optional(),
        limit: z.number().int().min(1).max(300).optional(),
      },
      _meta: { ui: { visibility: ['app'] } },
    },
    async (args) => {
      const videos = db.listVideos(args ?? {});
      return { content: [{ type: 'text', text: `${videos.length} videos` }], structuredContent: { videos } };
    },
  );

  server.registerTool(
    'app_upsert_channel',
    {
      description: 'Add or update a tracked channel',
      inputSchema: {
        id: z.number().int().positive().optional(),
        urlOrHandle: z.string().optional(),
        platform: z.enum(['tiktok', 'facebook']).optional(),
        handle: z.string().optional(),
        url: z.string().optional(),
        displayName: z.string().optional(),
        doctorGroup: z.string().optional(),
        enabled: z.boolean().optional(),
        month: z.string().optional(),
      },
      _meta: { ui: { visibility: ['app'] } },
    },
    async (args) => {
      let platform = args.platform;
      let handle = args.handle?.trim() ?? '';
      let url = args.url?.trim() ?? '';
      let displayName = args.displayName?.trim() ?? '';
      let doctorGroup = args.doctorGroup?.trim() ?? '';

      if (args.urlOrHandle) {
        const parsed = parseChannelLine(args.urlOrHandle);
        if (!parsed) {
          return {
            isError: true,
            content: [{ type: 'text', text: 'Invalid TikTok or Facebook URL/handle.' }],
          };
        }
        platform = platform ?? parsed.platform;
        handle = handle || parsed.handle;
        url = url || parsed.url;
        displayName = displayName || parsed.displayName;
        doctorGroup = doctorGroup || parsed.doctorGroup;
      }

      if (!platform || !handle || !url) {
        return { isError: true, content: [{ type: 'text', text: 'Missing platform, handle, or URL.' }] };
      }

      const channel = db.upsertChannel({
        id: args.id,
        platform,
        handle,
        url,
        displayName: displayName || handle,
        doctorGroup: doctorGroup || displayName || handle,
        enabled: args.enabled ?? true,
      });

      return {
        content: [{ type: 'text', text: `Saved ${channel.displayName}` }],
        structuredContent: { channel, dashboard: db.getDashboard({ month: args.month }) },
      };
    },
  );

  server.registerTool(
    'app_delete_channel',
    {
      description: 'Delete a tracked channel',
      inputSchema: { id: z.number().int().positive(), month: z.string().optional() },
      _meta: { ui: { visibility: ['app'] } },
    },
    async (args) => {
      const deleted = db.deleteChannel(args.id);
      return {
        content: [{ type: 'text', text: deleted ? 'Deleted' : 'Not found' }],
        structuredContent: { deleted, dashboard: db.getDashboard({ month: args.month }) },
      };
    },
  );

  server.registerTool(
    'app_import_channels_bulk',
    {
      description: 'Bulk import TikTok/Facebook channels from raw text lines',
      inputSchema: { rawText: z.string(), month: z.string().optional() },
      _meta: { ui: { visibility: ['app'] } },
    },
    async (args) => {
      const parsed = parseBulkChannelText(args.rawText);
      for (const item of parsed) db.upsertChannel(item);
      return {
        content: [{ type: 'text', text: `Imported ${parsed.length} channels.` }],
        structuredContent: { importedCount: parsed.length, dashboard: db.getDashboard({ month: args.month }) },
      };
    },
  );

  server.registerTool(
    'app_save_settings',
    {
      description: 'Save Apify token, actor IDs, Google Sheets input/output URLs, and budget limits',
      inputSchema: {
        apifyToken: z.string().optional(),
        tiktokActorId: z.string().optional(),
        facebookActorId: z.string().optional(),
        monthlyBudgetUsd: z.number().positive().optional(),
        perRunBudgetUsd: z.number().positive().optional(),
        defaultMaxVideosTiktok: z.number().int().min(1).max(100).optional(),
        defaultMaxVideosFacebook: z.number().int().min(1).max(100).optional(),
        googleSheetUrl: z.string().optional(),
        googleSheetTab: z.string().optional(),
        exportSheetUrl: z.string().optional(),
        month: z.string().optional(),
      },
      _meta: { ui: { visibility: ['app'] } },
    },
    async (args) => {
      const settings = db.saveSettings(args);
      return {
        content: [{ type: 'text', text: 'Settings saved.' }],
        structuredContent: { settings, dashboard: db.getDashboard({ month: args.month }) },
      };
    },
  );

  server.registerTool(
    'app_test_apify_token',
    {
      description: 'Verify Apify API token and fetch live monthly credit usage',
      inputSchema: { apifyToken: z.string().optional() },
      _meta: { ui: { visibility: ['app'] } },
    },
    async (args) => {
      const token = (args?.apifyToken?.trim() || db.getRawApifyToken()).trim();
      if (!token) {
        return { isError: true, content: [{ type: 'text', text: 'No Apify API token provided.' }] };
      }
      if (args?.apifyToken?.trim()) db.saveSettings({ apifyToken: args.apifyToken.trim() });
      const limits = await fetchApifyAccountLimits(token);
      if (!limits.error) db.saveCachedApifyLimits(limits);
      return {
        content: [
          {
            type: 'text',
            text: limits.error
              ? `Apify connection failed: ${limits.error}`
              : `Connected (@${limits.username ?? 'user'}) — Used $${(limits.monthlyUsageUsd ?? 0).toFixed(2)} / $${(limits.maxMonthlyUsageUsd ?? 5).toFixed(2)}`,
          },
        ],
        structuredContent: { limits, settings: db.getSettings() },
      };
    },
  );

  server.registerTool(
    'app_export_csv',
    {
      description: 'Export monthly channel or group rollup to UTF-8 BOM CSV',
      inputSchema: { month: z.string().optional(), mode: z.enum(['channels', 'doctors']).optional() },
      _meta: { ui: { visibility: ['app'] } },
    },
    async (args) => {
      const mode = args?.mode ?? 'channels';
      const dashboard = db.getDashboard({ month: args?.month });
      const csv =
        mode === 'doctors'
          ? buildDoctorsCsv(dashboard.month, dashboard.doctors)
          : buildChannelsCsv(dashboard.month, dashboard.channels);

      const exportsDir = path.join(dataDir, 'exports');
      fs.mkdirSync(exportsDir, { recursive: true });
      const fileName = `social-report-${mode === 'doctors' ? 'groups' : 'channels'}-${dashboard.month}.csv`;
      const filePath = path.join(exportsDir, fileName);
      fs.writeFileSync(filePath, csv, 'utf8');

      return {
        content: [{ type: 'text', text: `Exported ${filePath}` }],
        structuredContent: { fileName, filePath, fileUri: pathToFileURL(filePath).href, csv },
      };
    },
  );

  return { server, db };
}

async function main() {
  const { dataDir } = parseArgs(process.argv.slice(2));
  const { server } = createTrackerServer(dataDir);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error('[social-video-tracker] fatal error:', err);
    process.exit(1);
  });
}
