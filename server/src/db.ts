import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { getCurrentMonth, getMonthStartDate, maskSecret } from './parser.js';
import type {
  ApifyAccountLimits,
  Channel,
  ChannelMonthlyRow,
  DashboardPayload,
  DoctorMonthlyRow,
  Platform,
  ScanRun,
  TrackerSettings,
  VideoRecord,
} from './types.js';

export const DEFAULT_TIKTOK_ACTOR = 'clockworks/tiktok-profile-scraper';
export const DEFAULT_FACEBOOK_ACTOR = 'alfalfa/facebook-reels-scraper';

export class TrackerDb {
  readonly db: Database;
  readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
    const dbPath = path.join(dataDir, 'tracker.sqlite');
    this.db = new Database(dbPath, { create: true });
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.migrate();
    this.initDefaults();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS channels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL CHECK(platform IN ('tiktok', 'facebook')),
        handle TEXT NOT NULL,
        url TEXT NOT NULL,
        display_name TEXT NOT NULL,
        doctor_group TEXT NOT NULL,
        ug_owner TEXT NOT NULL DEFAULT '',
        specialty TEXT NOT NULL DEFAULT '',
        cooperation_status TEXT NOT NULL DEFAULT '',
        sheet_row INTEGER,
        enabled INTEGER NOT NULL DEFAULT 1,
        profile_video_count INTEGER,
        profile_followers INTEGER,
        last_scanned_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(platform, handle)
      );

      CREATE TABLE IF NOT EXISTS videos (
        id TEXT PRIMARY KEY,
        channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        platform TEXT NOT NULL CHECK(platform IN ('tiktok', 'facebook')),
        url TEXT NOT NULL,
        caption TEXT NOT NULL DEFAULT '',
        published_at TEXT,
        published_month TEXT,
        views INTEGER NOT NULL DEFAULT 0,
        likes INTEGER NOT NULL DEFAULT 0,
        comments INTEGER NOT NULL DEFAULT 0,
        shares INTEGER NOT NULL DEFAULT 0,
        duration_sec INTEGER,
        thumbnail_url TEXT,
        last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_videos_channel_month ON videos(channel_id, published_month);
      CREATE INDEX IF NOT EXISTS idx_videos_published_at ON videos(published_at);

      CREATE TABLE IF NOT EXISTS scan_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        apify_run_id TEXT,
        since_date TEXT NOT NULL,
        channels_count INTEGER NOT NULL DEFAULT 0,
        channel_ids_json TEXT,
        videos_fetched INTEGER NOT NULL DEFAULT 0,
        videos_in_period INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        error_message TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );
    `);

    const scanCols = this.db.query('PRAGMA table_info(scan_runs)').all() as Array<{ name: string }>;
    if (!scanCols.some((c) => c.name === 'channel_ids_json')) {
      this.db.exec('ALTER TABLE scan_runs ADD COLUMN channel_ids_json TEXT;');
    }
    const chCols = this.db.query('PRAGMA table_info(channels)').all() as Array<{ name: string }>;
    if (!chCols.some((c) => c.name === 'ug_owner')) {
      this.db.exec("ALTER TABLE channels ADD COLUMN ug_owner TEXT NOT NULL DEFAULT '';");
    }
    if (!chCols.some((c) => c.name === 'specialty')) {
      this.db.exec("ALTER TABLE channels ADD COLUMN specialty TEXT NOT NULL DEFAULT '';");
    }
    if (!chCols.some((c) => c.name === 'cooperation_status')) {
      this.db.exec("ALTER TABLE channels ADD COLUMN cooperation_status TEXT NOT NULL DEFAULT '';");
    }
    if (!chCols.some((c) => c.name === 'sheet_row')) {
      this.db.exec('ALTER TABLE channels ADD COLUMN sheet_row INTEGER;');
    }
  }

  private initDefaults() {
    const defaults: Record<string, string> = {
      apify_token: '',
      tiktok_actor_id: DEFAULT_TIKTOK_ACTOR,
      facebook_actor_id: DEFAULT_FACEBOOK_ACTOR,
      monthly_budget_usd: '5',
      per_run_budget_usd: '2.2',
      default_max_videos_tiktok: '18',
      default_max_videos_facebook: '20',
      google_sheet_url: '',
      google_sheet_tab: '',
      export_sheet_url: '',
    };

    const insertSetting = this.db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
    for (const [key, val] of Object.entries(defaults)) {
      insertSetting.run(key, val);
    }
  }

  getSetting(key: string): string {
    const row = this.db.query('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | null;
    return row ? row.value : '';
  }

  setSetting(key: string, value: string) {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  getRawApifyToken(): string {
    const stored = this.getSetting('apify_token').trim();
    if (stored) return stored;
    return (process.env.APIFY_TOKEN ?? '').trim();
  }

  getSettings(): TrackerSettings {
    const token = this.getRawApifyToken();
    return {
      hasApifyToken: token.length > 0,
      apifyTokenMasked: maskSecret(token),
      tiktokActorId: this.getSetting('tiktok_actor_id') || DEFAULT_TIKTOK_ACTOR,
      facebookActorId: this.getSetting('facebook_actor_id') || DEFAULT_FACEBOOK_ACTOR,
      monthlyBudgetUsd: Number(this.getSetting('monthly_budget_usd') || '5'),
      perRunBudgetUsd: Number(this.getSetting('per_run_budget_usd') || '2.2'),
      defaultMaxVideosTiktok: Number(this.getSetting('default_max_videos_tiktok') || '18'),
      defaultMaxVideosFacebook: Number(this.getSetting('default_max_videos_facebook') || '20'),
      googleSheetUrl: this.getSetting('google_sheet_url') || '',
      googleSheetTab: this.getSetting('google_sheet_tab') || '',
      exportSheetUrl: this.getSetting('export_sheet_url') || '',
    };
  }

  saveSettings(input: Partial<{
    apifyToken: string;
    tiktokActorId: string;
    facebookActorId: string;
    monthlyBudgetUsd: number;
    perRunBudgetUsd: number;
    defaultMaxVideosTiktok: number;
    defaultMaxVideosFacebook: number;
    googleSheetUrl: string;
    googleSheetTab: string;
    exportSheetUrl: string;
  }>): TrackerSettings {
    if (typeof input.apifyToken === 'string') this.setSetting('apify_token', input.apifyToken.trim());
    if (typeof input.tiktokActorId === 'string' && input.tiktokActorId.trim()) {
      this.setSetting('tiktok_actor_id', input.tiktokActorId.trim());
    }
    if (typeof input.facebookActorId === 'string' && input.facebookActorId.trim()) {
      this.setSetting('facebook_actor_id', input.facebookActorId.trim());
    }
    if (typeof input.monthlyBudgetUsd === 'number' && input.monthlyBudgetUsd > 0) {
      this.setSetting('monthly_budget_usd', String(input.monthlyBudgetUsd));
    }
    if (typeof input.perRunBudgetUsd === 'number' && input.perRunBudgetUsd > 0) {
      this.setSetting('per_run_budget_usd', String(input.perRunBudgetUsd));
    }
    if (typeof input.defaultMaxVideosTiktok === 'number' && input.defaultMaxVideosTiktok > 0) {
      this.setSetting('default_max_videos_tiktok', String(Math.round(input.defaultMaxVideosTiktok)));
    }
    if (typeof input.defaultMaxVideosFacebook === 'number' && input.defaultMaxVideosFacebook > 0) {
      this.setSetting('default_max_videos_facebook', String(Math.round(input.defaultMaxVideosFacebook)));
    }
    if (typeof input.googleSheetUrl === 'string') this.setSetting('google_sheet_url', input.googleSheetUrl.trim());
    if (typeof input.googleSheetTab === 'string') this.setSetting('google_sheet_tab', input.googleSheetTab.trim());
    if (typeof input.exportSheetUrl === 'string') this.setSetting('export_sheet_url', input.exportSheetUrl.trim());
    return this.getSettings();
  }

  getCachedApifyLimits(): ApifyAccountLimits | null {
    const raw = this.getSetting('apify_limits_cache');
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ApifyAccountLimits;
    } catch {
      return null;
    }
  }

  saveCachedApifyLimits(limits: ApifyAccountLimits) {
    this.setSetting('apify_limits_cache', JSON.stringify(limits));
  }

  private mapChannelRow(row: Record<string, unknown>): Channel {
    return {
      id: Number(row.id),
      platform: row.platform as Platform,
      handle: String(row.handle),
      url: String(row.url),
      displayName: String(row.display_name),
      doctorGroup: String(row.doctor_group),
      ugOwner: String(row.ug_owner ?? ''),
      specialty: String(row.specialty ?? ''),
      cooperationStatus: String(row.cooperation_status ?? ''),
      sheetRow: row.sheet_row === null || row.sheet_row === undefined ? null : Number(row.sheet_row),
      enabled: Boolean(row.enabled),
      profileVideoCount: row.profile_video_count === null ? null : Number(row.profile_video_count),
      profileFollowers: row.profile_followers === null ? null : Number(row.profile_followers),
      lastScannedAt: row.last_scanned_at ? String(row.last_scanned_at) : null,
      lastError: row.last_error ? String(row.last_error) : null,
      createdAt: String(row.created_at),
    };
  }

  listChannels(filter?: { platform?: Platform | 'all'; enabledOnly?: boolean; ids?: number[] }): Channel[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (filter?.platform && filter.platform !== 'all') {
      clauses.push('platform = ?');
      params.push(filter.platform);
    }
    if (filter?.enabledOnly) clauses.push('enabled = 1');
    if (filter?.ids && filter.ids.length > 0) {
      clauses.push(`id IN (${filter.ids.map(() => '?').join(',')})`);
      params.push(...filter.ids);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.query(`SELECT * FROM channels ${where} ORDER BY id ASC`).all(...params) as Record<string, unknown>[];
    return rows.map((r) => this.mapChannelRow(r));
  }

  upsertChannel(input: {
    id?: number;
    platform: Platform;
    handle: string;
    url: string;
    displayName: string;
    doctorGroup: string;
    ugOwner?: string;
    specialty?: string;
    cooperationStatus?: string;
    sheetRow?: number | null;
    enabled?: boolean;
  }): Channel {
    const enabledInt = input.enabled === false ? 0 : 1;
    const ugOwner = input.ugOwner ?? '';
    const specialty = input.specialty ?? '';
    const cooperationStatus = input.cooperationStatus ?? '';
    const sheetRow = input.sheetRow ?? null;

    if (input.id) {
      this.db
        .prepare(`
          UPDATE channels
          SET platform = ?, handle = ?, url = ?, display_name = ?, doctor_group = ?,
              ug_owner = CASE WHEN ? != '' THEN ? ELSE ug_owner END,
              specialty = CASE WHEN ? != '' THEN ? ELSE specialty END,
              cooperation_status = CASE WHEN ? != '' THEN ? ELSE cooperation_status END,
              sheet_row = COALESCE(?, sheet_row),
              enabled = ?
          WHERE id = ?
        `)
        .run(
          input.platform,
          input.handle,
          input.url,
          input.displayName,
          input.doctorGroup,
          ugOwner,
          ugOwner,
          specialty,
          specialty,
          cooperationStatus,
          cooperationStatus,
          sheetRow,
          enabledInt,
          input.id,
        );
      const updated = this.db.query('SELECT * FROM channels WHERE id = ?').get(input.id) as Record<string, unknown>;
      return this.mapChannelRow(updated);
    }

    this.db
      .prepare(`
        INSERT INTO channels (platform, handle, url, display_name, doctor_group, ug_owner, specialty, cooperation_status, sheet_row, enabled)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(platform, handle) DO UPDATE SET
          url = excluded.url,
          display_name = excluded.display_name,
          doctor_group = excluded.doctor_group,
          ug_owner = CASE WHEN excluded.ug_owner != '' THEN excluded.ug_owner ELSE channels.ug_owner END,
          specialty = CASE WHEN excluded.specialty != '' THEN excluded.specialty ELSE channels.specialty END,
          cooperation_status = CASE WHEN excluded.cooperation_status != '' THEN excluded.cooperation_status ELSE channels.cooperation_status END,
          sheet_row = COALESCE(excluded.sheet_row, channels.sheet_row),
          enabled = excluded.enabled
      `)
      .run(
        input.platform,
        input.handle,
        input.url,
        input.displayName,
        input.doctorGroup,
        ugOwner,
        specialty,
        cooperationStatus,
        sheetRow,
        enabledInt,
      );

    const row = this.db
      .query('SELECT * FROM channels WHERE platform = ? AND handle = ?')
      .get(input.platform, input.handle) as Record<string, unknown>;
    return this.mapChannelRow(row);
  }

  deleteChannel(id: number): boolean {
    return this.db.prepare('DELETE FROM channels WHERE id = ?').run(id).changes > 0;
  }

  updateChannelScanMeta(
    channelId: number,
    meta: {
      profileVideoCount?: number | null;
      profileFollowers?: number | null;
      lastScannedAt: string;
      lastError?: string | null;
    },
  ) {
    this.db
      .prepare(`
        UPDATE channels
        SET
          profile_video_count = COALESCE(?, profile_video_count),
          profile_followers = COALESCE(?, profile_followers),
          last_scanned_at = ?,
          last_error = ?
        WHERE id = ?
      `)
      .run(
        meta.profileVideoCount ?? null,
        meta.profileFollowers ?? null,
        meta.lastScannedAt,
        meta.lastError ?? null,
        channelId,
      );
  }

  upsertVideos(videos: Omit<VideoRecord, 'lastSeenAt'>[]): number {
    const stmt = this.db.prepare(`
      INSERT INTO videos (
        id, channel_id, platform, url, caption, published_at, published_month,
        views, likes, comments, shares, duration_sec, thumbnail_url, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        url = excluded.url,
        caption = CASE WHEN excluded.caption != '' THEN excluded.caption ELSE videos.caption END,
        published_at = COALESCE(excluded.published_at, videos.published_at),
        published_month = COALESCE(excluded.published_month, videos.published_month),
        views = MAX(videos.views, excluded.views),
        likes = MAX(videos.likes, excluded.likes),
        comments = MAX(videos.comments, excluded.comments),
        shares = MAX(videos.shares, excluded.shares),
        duration_sec = COALESCE(excluded.duration_sec, videos.duration_sec),
        thumbnail_url = COALESCE(excluded.thumbnail_url, videos.thumbnail_url),
        last_seen_at = datetime('now')
    `);

    const tx = this.db.transaction(() => {
      for (const v of videos) {
        stmt.run(
          v.id,
          v.channelId,
          v.platform,
          v.url,
          v.caption,
          v.publishedAt,
          v.publishedMonth,
          v.views,
          v.likes,
          v.comments,
          v.shares,
          v.durationSec,
          v.thumbnailUrl,
        );
      }
    });
    tx();
    return videos.length;
  }

  recordScanRun(run: Omit<ScanRun, 'id'>): ScanRun {
    const info = this.db
      .prepare(`
        INSERT INTO scan_runs (
          platform, actor_id, apify_run_id, since_date, channels_count, channel_ids_json,
          videos_fetched, videos_in_period, cost_usd, status, error_message,
          started_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        run.platform,
        run.actorId,
        run.apifyRunId,
        run.sinceDate,
        run.channelsCount,
        run.channelIds ? JSON.stringify(run.channelIds) : null,
        run.videosFetched,
        run.videosInPeriod,
        run.costUsd,
        run.status,
        run.errorMessage,
        run.startedAt,
        run.finishedAt,
      );
    return { id: Number(info.lastInsertRowid), ...run };
  }

  updateScanRun(
    id: number,
    patch: Partial<Pick<ScanRun, 'videosFetched' | 'videosInPeriod' | 'costUsd' | 'status' | 'errorMessage' | 'finishedAt'>>,
  ) {
    const fields: string[] = [];
    const params: (string | number | null)[] = [];
    if (patch.videosFetched !== undefined) {
      fields.push('videos_fetched = ?');
      params.push(patch.videosFetched);
    }
    if (patch.videosInPeriod !== undefined) {
      fields.push('videos_in_period = ?');
      params.push(patch.videosInPeriod);
    }
    if (patch.costUsd !== undefined) {
      fields.push('cost_usd = ?');
      params.push(patch.costUsd);
    }
    if (patch.status !== undefined) {
      fields.push('status = ?');
      params.push(patch.status);
    }
    if (patch.errorMessage !== undefined) {
      fields.push('error_message = ?');
      params.push(patch.errorMessage);
    }
    if (patch.finishedAt !== undefined) {
      fields.push('finished_at = ?');
      params.push(patch.finishedAt);
    }
    if (fields.length === 0) return;
    params.push(id);
    this.db.prepare(`UPDATE scan_runs SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  }

  private mapScanRunRow(r: Record<string, unknown>): ScanRun {
    let channelIds: number[] | undefined;
    if (typeof r.channel_ids_json === 'string' && r.channel_ids_json) {
      try {
        channelIds = JSON.parse(r.channel_ids_json) as number[];
      } catch {
        channelIds = undefined;
      }
    }
    return {
      id: Number(r.id),
      platform: r.platform as Platform | 'all',
      actorId: String(r.actor_id),
      apifyRunId: r.apify_run_id ? String(r.apify_run_id) : null,
      sinceDate: String(r.since_date),
      channelsCount: Number(r.channels_count),
      channelIds,
      videosFetched: Number(r.videos_fetched),
      videosInPeriod: Number(r.videos_in_period),
      costUsd: Number(r.cost_usd),
      status: r.status as ScanRun['status'],
      errorMessage: r.error_message ? String(r.error_message) : null,
      startedAt: String(r.started_at),
      finishedAt: r.finished_at ? String(r.finished_at) : null,
    };
  }

  listRunningRuns(): ScanRun[] {
    const rows = this.db
      .query(`SELECT * FROM scan_runs WHERE status = 'running' AND apify_run_id IS NOT NULL ORDER BY id ASC`)
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.mapScanRunRow(r));
  }

  getMonthLocalSpendUsd(month?: string): number {
    const m = month || getCurrentMonth();
    const row = this.db
      .query(`
        SELECT COALESCE(SUM(cost_usd), 0) AS total
        FROM scan_runs
        WHERE status IN ('running', 'succeeded', 'partial', 'failed')
          AND substr(started_at, 1, 7) = ?
      `)
      .get(m) as { total: number };
    return Number(row.total || 0);
  }

  listRecentRuns(limit = 12): ScanRun[] {
    const rows = this.db.query('SELECT * FROM scan_runs ORDER BY id DESC LIMIT ?').all(limit) as Record<string, unknown>[];
    return rows.map((r) => this.mapScanRunRow(r));
  }

  listVideos(options: {
    month?: string;
    channelId?: number;
    platform?: Platform | 'all';
    sortBy?: 'views' | 'published_at';
    limit?: number;
  }): Array<VideoRecord & { channelName: string; doctorGroup: string; channelHandle: string }> {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (options.month && /^\d{4}-\d{2}$/.test(options.month)) {
      clauses.push('v.published_month = ?');
      params.push(options.month);
    }
    if (options.channelId) {
      clauses.push('v.channel_id = ?');
      params.push(options.channelId);
    }
    if (options.platform && options.platform !== 'all') {
      clauses.push('v.platform = ?');
      params.push(options.platform);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const order =
      options.sortBy === 'published_at'
        ? 'ORDER BY COALESCE(v.published_at, v.last_seen_at) DESC'
        : 'ORDER BY v.views DESC, COALESCE(v.published_at, v.last_seen_at) DESC';
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 300);

    const rows = this.db
      .query(`
        SELECT v.*, c.display_name AS channel_name, c.doctor_group AS doctor_group, c.handle AS channel_handle
        FROM videos v
        JOIN channels c ON c.id = v.channel_id
        ${where}
        ${order}
        LIMIT ?
      `)
      .all(...params, limit) as Record<string, unknown>[];

    return rows.map((r) => ({
      id: String(r.id),
      channelId: Number(r.channel_id),
      platform: r.platform as Platform,
      url: String(r.url),
      caption: String(r.caption || ''),
      publishedAt: r.published_at ? String(r.published_at) : null,
      publishedMonth: r.published_month ? String(r.published_month) : null,
      views: Number(r.views || 0),
      likes: Number(r.likes || 0),
      comments: Number(r.comments || 0),
      shares: Number(r.shares || 0),
      durationSec: r.duration_sec === null ? null : Number(r.duration_sec),
      thumbnailUrl: r.thumbnail_url ? String(r.thumbnail_url) : null,
      lastSeenAt: String(r.last_seen_at),
      channelName: String(r.channel_name),
      doctorGroup: String(r.doctor_group),
      channelHandle: String(r.channel_handle),
    }));
  }

  getDashboard(options?: { month?: string; platform?: Platform | 'all'; search?: string }): DashboardPayload {
    const month = options?.month && /^\d{4}-\d{2}$/.test(options.month) ? options.month : getCurrentMonth();
    const sinceDate = getMonthStartDate(month);
    const settings = this.getSettings();
    const allChannels = this.listChannels();

    const periodAggRows = this.db
      .query(`
        SELECT
          channel_id,
          COUNT(*) AS period_videos,
          COALESCE(SUM(views), 0) AS period_views,
          COALESCE(SUM(likes), 0) AS period_likes,
          COALESCE(SUM(comments), 0) AS period_comments,
          COALESCE(SUM(shares), 0) AS period_shares,
          MAX(published_at) AS latest_video_at
        FROM videos
        WHERE published_month = ?
        GROUP BY channel_id
      `)
      .all(month) as Record<string, unknown>[];

    const periodMap = new Map<number, Record<string, unknown>>();
    for (const r of periodAggRows) periodMap.set(Number(r.channel_id), r);

    const allTimeRows = this.db
      .query(`
        SELECT channel_id, COUNT(*) AS total_videos, COALESCE(SUM(views), 0) AS total_views
        FROM videos GROUP BY channel_id
      `)
      .all() as Record<string, unknown>[];

    const allTimeMap = new Map<number, { totalVideos: number; totalViews: number }>();
    for (const r of allTimeRows) {
      allTimeMap.set(Number(r.channel_id), {
        totalVideos: Number(r.total_videos || 0),
        totalViews: Number(r.total_views || 0),
      });
    }

    const searchLower = (options?.search || '').trim().toLowerCase();
    const platformFilter = options?.platform || 'all';

    const channelRows: ChannelMonthlyRow[] = [];
    const doctorMap = new Map<string, DoctorMonthlyRow>();

    let tiktokPeriodVideos = 0;
    let tiktokPeriodViews = 0;
    let tiktokPeriodLikes = 0;
    let tiktokPeriodComments = 0;
    let tiktokPeriodShares = 0;
    let facebookPeriodVideos = 0;
    let facebookPeriodViews = 0;
    let facebookPeriodLikes = 0;
    let facebookPeriodComments = 0;
    let facebookPeriodShares = 0;

    for (const ch of allChannels) {
      const p = periodMap.get(ch.id);
      const a = allTimeMap.get(ch.id);
      const periodVideos = Number(p?.period_videos || 0);
      const periodViews = Number(p?.period_views || 0);
      const periodLikes = Number(p?.period_likes || 0);
      const periodComments = Number(p?.period_comments || 0);
      const periodShares = Number(p?.period_shares || 0);

      if (ch.platform === 'tiktok') {
        tiktokPeriodVideos += periodVideos;
        tiktokPeriodViews += periodViews;
        tiktokPeriodLikes += periodLikes;
        tiktokPeriodComments += periodComments;
        tiktokPeriodShares += periodShares;
      } else {
        facebookPeriodVideos += periodVideos;
        facebookPeriodViews += periodViews;
        facebookPeriodLikes += periodLikes;
        facebookPeriodComments += periodComments;
        facebookPeriodShares += periodShares;
      }

      const matchesPlatform = platformFilter === 'all' || ch.platform === platformFilter;
      const matchesSearch =
        !searchLower ||
        ch.displayName.toLowerCase().includes(searchLower) ||
        ch.doctorGroup.toLowerCase().includes(searchLower) ||
        ch.ugOwner.toLowerCase().includes(searchLower) ||
        ch.cooperationStatus.toLowerCase().includes(searchLower) ||
        ch.handle.toLowerCase().includes(searchLower);

      if (matchesPlatform && matchesSearch) {
        channelRows.push({
          channel: ch,
          periodVideos,
          periodViews,
          periodLikes,
          periodComments,
          periodShares,
          avgViews: periodVideos > 0 ? Math.round(periodViews / periodVideos) : 0,
          allTimeTrackedVideos: a?.totalVideos ?? 0,
          allTimeTrackedViews: a?.totalViews ?? 0,
          latestVideoAt: p?.latest_video_at ? String(p.latest_video_at) : null,
        });
      }

      const existingDoc = doctorMap.get(ch.doctorGroup) ?? {
        doctorGroup: ch.doctorGroup,
        channelsCount: 0,
        platforms: [],
        tiktokVideos: 0,
        tiktokViews: 0,
        facebookVideos: 0,
        facebookViews: 0,
        totalVideos: 0,
        totalViews: 0,
        totalLikes: 0,
        totalComments: 0,
        totalShares: 0,
        avgViews: 0,
      };
      existingDoc.channelsCount += 1;
      if (!existingDoc.platforms.includes(ch.platform)) existingDoc.platforms.push(ch.platform);
      if (ch.platform === 'tiktok') {
        existingDoc.tiktokVideos += periodVideos;
        existingDoc.tiktokViews += periodViews;
      } else {
        existingDoc.facebookVideos += periodVideos;
        existingDoc.facebookViews += periodViews;
      }
      existingDoc.totalVideos += periodVideos;
      existingDoc.totalViews += periodViews;
      existingDoc.totalLikes += periodLikes;
      existingDoc.totalComments += periodComments;
      existingDoc.totalShares += periodShares;
      existingDoc.avgViews =
        existingDoc.totalVideos > 0 ? Math.round(existingDoc.totalViews / existingDoc.totalVideos) : 0;
      doctorMap.set(ch.doctorGroup, existingDoc);
    }

    channelRows.sort((a, b) => b.periodViews - a.periodViews || b.periodVideos - a.periodVideos || a.channel.id - b.channel.id);

    const doctors = Array.from(doctorMap.values())
      .filter((d) => !searchLower || d.doctorGroup.toLowerCase().includes(searchLower))
      .sort((a, b) => b.totalViews - a.totalViews || b.totalVideos - a.totalVideos || a.doctorGroup.localeCompare(b.doctorGroup));

    const totalPeriodVideos = tiktokPeriodVideos + facebookPeriodVideos;
    const totalPeriodViews = tiktokPeriodViews + facebookPeriodViews;
    const totalPeriodLikes = tiktokPeriodLikes + facebookPeriodLikes;
    const totalPeriodComments = tiktokPeriodComments + facebookPeriodComments;
    const totalPeriodShares = tiktokPeriodShares + facebookPeriodShares;
    const monthSpendUsd = Number(this.getMonthLocalSpendUsd(month).toFixed(4));
    const remainingLocalBudgetUsd = Number(Math.max(0, settings.monthlyBudgetUsd - monthSpendUsd).toFixed(4));

    return {
      month,
      sinceDate,
      generatedAt: new Date().toISOString(),
      summary: {
        totalChannels: allChannels.length,
        enabledChannels: allChannels.filter((c) => c.enabled).length,
        tiktokChannels: allChannels.filter((c) => c.platform === 'tiktok').length,
        facebookChannels: allChannels.filter((c) => c.platform === 'facebook').length,
        periodVideos: totalPeriodVideos,
        periodViews: totalPeriodViews,
        periodLikes: totalPeriodLikes,
        periodComments: totalPeriodComments,
        periodShares: totalPeriodShares,
        tiktokPeriodVideos,
        tiktokPeriodViews,
        tiktokPeriodLikes,
        tiktokPeriodComments,
        facebookPeriodVideos,
        facebookPeriodViews,
        facebookPeriodLikes,
        facebookPeriodComments,
        avgViewsPerVideo: totalPeriodVideos > 0 ? Math.round(totalPeriodViews / totalPeriodVideos) : 0,
        monthSpendUsd,
        monthlyBudgetUsd: settings.monthlyBudgetUsd,
        remainingLocalBudgetUsd,
      },
      settings,
      apifyLimits: this.getCachedApifyLimits(),
      channels: channelRows,
      doctors,
      recentRuns: this.listRecentRuns(10),
      activeRuns: this.listRunningRuns(),
    };
  }
}
